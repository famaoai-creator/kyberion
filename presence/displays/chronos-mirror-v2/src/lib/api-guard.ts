import { NextRequest, NextResponse } from 'next/server';
import { resolveAuthnPrincipal } from '@agent/core/authn-principal-resolver';
import { consumeTenantBudget } from '@agent/core/organization/tenant-rate-limiter';
import {
  extractSurfaceBearerToken,
  resolveSurfaceViewerToken,
} from '@agent/core/surface/surface-mutation-guard';
import {
  SURFACE_SESSION_COOKIE,
  SURFACE_SESSION_TOKEN_PREFIX,
  isSameOriginMutation,
} from '@agent/core/surface/surface-session-cookie';
import { withExecutionContext } from '@agent/core/authority';
import {
  CHRONOS_TOKEN_REGISTRY_READER_ROLE,
  findChronosTokenRegistration,
  readChronosTokenRegistrations,
  type ChronosAccessRole,
  type ChronosTokenRegistration,
} from '@agent/core/chronos-access-registry';
import { getRegisteredEnvBool, getRegisteredEnvText } from '@agent/core/foundation';

/**
 * API Guard: Authentication + Rate Limiting for Chronos Mirror API routes.
 *
 * Authentication: Bearer token or session-based.
 * Rate Limiting: Per-IP sliding window.
 */

const API_TOKEN = getRegisteredEnvText('KYBERION_API_TOKEN');
const LOCALADMIN_TOKEN = getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN');
const ALLOW_UNAUTH_REMOTE = getRegisteredEnvBool('KYBERION_ALLOW_UNAUTH_REMOTE') === true;
const ALLOW_LOCALHOST_AUTOADMIN =
  getRegisteredEnvBool('KYBERION_LOCALHOST_AUTOADMIN', {
    defaultValue: true,
  }) === true;

export type {
  ChronosAccessRole,
  ChronosTokenRegistration,
} from '@agent/core/chronos-access-registry';
export { matchesChronosToken } from '@agent/core/chronos-access-registry';

function loadChronosTokenRegistrations(): ChronosTokenRegistration[] {
  try {
    // TR-01: read under the narrow registry reader role (see viewer-context.ts).
    return (
      withExecutionContext(CHRONOS_TOKEN_REGISTRY_READER_ROLE, () =>
        readChronosTokenRegistrations()
      ) || []
    );
  } catch {
    return [];
  }
}

export function resolveChronosTokenRegistration(token: string): ChronosTokenRegistration | null {
  return findChronosTokenRegistration(token, loadChronosTokenRegistrations());
}

// In-memory rate limit store
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 3000; // requests
const RATE_LIMIT_WINDOW = 60000; // 1 minute

function getClientIP(req: NextRequest): string {
  return (
    (req as NextRequest & { ip?: string }).ip ||
    (getRegisteredEnvBool('KYBERION_TRUST_PROXY') === true
      ? req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      : undefined) ||
    'unknown'
  );
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function isChronosLoopbackRequest(req: NextRequest): boolean {
  const directIp = (req as NextRequest & { ip?: string }).ip;
  const peerIp =
    directIp ||
    (getRegisteredEnvBool('KYBERION_TRUST_PROXY') === true
      ? req.headers.get('x-real-ip')?.trim() ||
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      : undefined);
  // Host is routing metadata, not caller identity. When Next does not expose
  // the socket peer, only an explicit loopback peer header is accepted; a
  // remote client cannot obtain localadmin by sending `Host: localhost`.
  return Boolean(peerIp && isLoopback(peerIp));
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
  return (
    extractSurfaceBearerToken(req.headers.get('authorization')) ||
    req.cookies.get('kyberion_token')?.value ||
    req.cookies.get(SURFACE_SESSION_COOKIE)?.value ||
    null
  );
}

/**
 * True when the credential is the OIDC `kyberion_session` cookie (no header,
 * no legacy `kyberion_token` cookie) and the request is an unsafe cross-origin
 * mutation. Header credentials and the pre-existing `kyberion_token` cookie
 * keep their previous behaviour and skip the check.
 */
function isBlockedCookieMutation(req: NextRequest): boolean {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (extractSurfaceBearerToken(req.headers.get('authorization'))) return false;
  if (req.cookies.get('kyberion_token')?.value) return false;
  if (!req.cookies.get(SURFACE_SESSION_COOKIE)?.value) return false;
  return !isSameOriginMutation({
    method,
    headers: req.headers,
    expectedHost: req.headers.get('host') || '',
  });
}

function crossOriginResponse(): NextResponse {
  return NextResponse.json({ error: 'Cross-origin request blocked.' }, { status: 403 });
}

function getRateLimitKey(req: NextRequest): string {
  const token = resolveChronosToken(req);
  if (token) {
    return `token:${token}`;
  }
  return `ip:${getClientIP(req)}`;
}

function resolveBrowserSessionRole(token: string): ChronosAccessRole | null {
  try {
    return resolveAuthnPrincipal(
      { credential: { type: 'bearer', token } },
      { providerIds: ['browser-session'], purpose: 'remote_human', context: { surface: 'chronos' } }
    ).principal.role;
  } catch {
    // Expired / forged / unbound / suspended — all fail closed to 401.
    return null;
  }
}

export function resolveChronosAccessRole(req: NextRequest): ChronosAccessRole | null {
  const token = resolveChronosToken(req);
  const isLocal = isChronosLoopbackRequest(req);
  if (token && token.startsWith(SURFACE_SESSION_TOKEN_PREFIX)) {
    // OIDC browser session: the role comes from the bound member (re-read on
    // every request), not from a static token or registry entry.
    return resolveBrowserSessionRole(token);
  }
  if (token) {
    const resolution = resolveSurfaceViewerToken(token, {
      registrations: loadChronosTokenRegistrations(),
      apiToken: API_TOKEN,
      localadminToken: LOCALADMIN_TOKEN,
    });
    if (resolution) return resolution.role;
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
  if (isBlockedCookieMutation(req)) return crossOriginResponse();

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
  if (isBlockedCookieMutation(req)) return crossOriginResponse();
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
