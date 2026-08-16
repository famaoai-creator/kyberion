import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { secretGuard } from '@agent/core/secret-guard';
import {
  consumeTenantBudget,
  isValidTenantSlug,
  pathResolver,
  safeExistsSync,
  type OsKnowledgeTier,
} from '@agent/core';

/**
 * API Guard: Authentication + Rate Limiting for Chronos Mirror API routes.
 *
 * Authentication: Bearer token or session-based.
 * Rate Limiting: Per-IP sliding window.
 */

const API_TOKEN = process.env.KYBERION_API_TOKEN;
const LOCALADMIN_TOKEN = process.env.KYBERION_LOCALADMIN_TOKEN;
const ALLOW_UNAUTH_REMOTE = process.env.KYBERION_ALLOW_UNAUTH_REMOTE === 'true';
const ALLOW_LOCALHOST_AUTOADMIN = process.env.KYBERION_LOCALHOST_AUTOADMIN !== 'false';
const SCOPE_ID_PATTERN = /^[^\s/]+$/u;

function isValidScopeId(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_ID_PATTERN.test(value);
}

export type ChronosAccessRole = 'readonly' | 'localadmin';

export interface ChronosTokenRegistration {
  token_hash: string;
  role: ChronosAccessRole;
  tenant_slugs: string[];
  organization_ids?: string[];
  project_ids?: string[];
  tier_access?: OsKnowledgeTier[];
  label?: string;
}

export function matchesChronosToken(candidate: string, configured: string | undefined): boolean {
  if (!candidate || !configured) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loadChronosTokenRegistrations(): ChronosTokenRegistration[] {
  const path = pathResolver.knowledge('personal/connections/chronos-access.json');
  if (!safeExistsSync(path)) return [];
  try {
    const document = secretGuard.loadConnectionDocument('chronos-access');
    if (!document || !Array.isArray(document.tokens)) return [];
    return document.tokens.filter((entry: unknown): entry is ChronosTokenRegistration => {
      if (!entry || typeof entry !== 'object') return false;
      const value = entry as Record<string, unknown>;
      return (
        typeof value.token_hash === 'string' &&
        (value.role === 'readonly' || value.role === 'localadmin') &&
        Array.isArray(value.tenant_slugs) &&
        value.tenant_slugs.every(
          (tenant) => typeof tenant === 'string' && isValidTenantSlug(tenant)
        ) &&
        (value.organization_ids === undefined ||
          (Array.isArray(value.organization_ids) &&
            value.organization_ids.every(isValidScopeId))) &&
        (value.project_ids === undefined ||
          (Array.isArray(value.project_ids) && value.project_ids.every(isValidScopeId))) &&
        (value.tier_access === undefined ||
          (Array.isArray(value.tier_access) &&
            value.tier_access.every(
              (tier) => tier === 'public' || tier === 'confidential' || tier === 'personal'
            )))
      );
    });
  } catch {
    return [];
  }
}

export function resolveChronosTokenRegistration(token: string): ChronosTokenRegistration | null {
  const digest = createHash('sha256').update(token).digest('hex');
  return (
    loadChronosTokenRegistrations().find((entry) =>
      matchesChronosToken(digest, entry.token_hash)
    ) || null
  );
}

// In-memory rate limit store
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 3000; // requests
const RATE_LIMIT_WINDOW = 60000; // 1 minute

function getClientIP(req: NextRequest): string {
  return (
    (req as NextRequest & { ip?: string }).ip ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isChronosLoopbackRequest(req: NextRequest): boolean {
  const directIp = (req as NextRequest & { ip?: string }).ip;
  const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (directIp !== undefined) {
    return isLoopback(directIp) && (!forwardedFor || isLoopback(forwardedFor));
  }
  return isLoopbackHostname(req.nextUrl?.hostname) && (!forwardedFor || isLoopback(forwardedFor));
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  rateLimitStore.set(ip, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

/**
 * Validate an incoming API request.
 * Returns null if OK, or a NextResponse error if rejected.
 */
export function resolveChronosToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return bearer || req.cookies.get('kyberion_token')?.value || null;
}

function getRateLimitKey(req: NextRequest): string {
  const token = resolveChronosToken(req);
  if (token) {
    return `token:${token}`;
  }
  return `ip:${getClientIP(req)}`;
}

export function resolveChronosAccessRole(req: NextRequest): ChronosAccessRole | null {
  const token = resolveChronosToken(req);
  const isLocal = isChronosLoopbackRequest(req);

  if (matchesChronosToken(token || '', LOCALADMIN_TOKEN)) {
    return 'localadmin';
  }
  if (matchesChronosToken(token || '', API_TOKEN)) {
    return 'readonly';
  }
  if (token) {
    const registration = resolveChronosTokenRegistration(token);
    if (registration) return registration.role;
  }
  // A supplied but invalid credential must not fall through to the
  // loopback auto-admin compatibility path.
  if (token) return null;
  if (isLocal && ALLOW_LOCALHOST_AUTOADMIN) {
    return 'localadmin';
  }
  if (isLocal) {
    return 'readonly';
  }
  if (!API_TOKEN && !LOCALADMIN_TOKEN && ALLOW_UNAUTH_REMOTE) {
    return 'readonly';
  }
  return null;
}

export function guardRequest(req: NextRequest): NextResponse | null {
  // Rate limiting (always applied)
  if (!checkRateLimit(getRateLimitKey(req))) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 });
  }

  if (!resolveChronosAccessRole(req)) {
    return NextResponse.json(
      {
        error:
          'Unauthorized. Use a local session, KYBERION_API_TOKEN, or KYBERION_LOCALADMIN_TOKEN.',
      },
      { status: 401 }
    );
  }

  const registration = resolveChronosTokenRegistration(resolveChronosToken(req) || '');
  const tenantSlugs = registration?.tenant_slugs || [];
  const budget = consumeTenantBudget({
    op: 'surface:chronos_request',
    ...(tenantSlugs.length === 1 ? { tenantSlug: tenantSlugs[0] } : {}),
  });
  if (!budget.allowed) {
    return NextResponse.json(
      { error: 'Tenant rate limit exceeded.', retry_after_ms: budget.retry_after_ms },
      { status: 429 }
    );
  }

  return null; // OK
}

export function requireChronosAccess(
  req: NextRequest,
  requiredRole: ChronosAccessRole
): NextResponse | null {
  const resolved = resolveChronosAccessRole(req);
  if (!resolved) {
    return NextResponse.json(
      {
        error:
          'Unauthorized. Use a local session, KYBERION_API_TOKEN, or KYBERION_LOCALADMIN_TOKEN.',
      },
      { status: 401 }
    );
  }
  if (requiredRole === 'localadmin' && resolved !== 'localadmin') {
    return NextResponse.json(
      { error: 'Forbidden. This action requires Chronos localadmin access.' },
      { status: 403 }
    );
  }
  return null;
}

export function roleToMissionRole(accessRole: ChronosAccessRole): string {
  if (accessRole === 'localadmin') {
    return 'chronos_localadmin';
  }
  return 'chronos_operator';
}

export function getChronosAccessRoleOrThrow(req: NextRequest): ChronosAccessRole {
  const resolved = resolveChronosAccessRole(req);
  if (!resolved) {
    throw new Error('Chronos access role was requested before authentication succeeded.');
  }
  return resolved;
}
