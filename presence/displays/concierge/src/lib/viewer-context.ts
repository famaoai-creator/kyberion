import { NextResponse, type NextRequest } from 'next/server';
import { currentScope } from '@agent/core/scope-context';
import {
  readChronosTokenRegistrations,
  type ChronosAccessRole,
  type ChronosTokenRegistration,
} from '@agent/core/chronos-access-registry';
import {
  defaultSurfaceViewerTierAccess,
  narrowSurfaceViewerScope,
  resolveSurfaceViewerScope,
  SurfaceViewerScopeError,
  resolveSurfaceViewerTierAccess,
  extractSurfaceBearerToken,
} from '@agent/core/surface-mutation-guard';
import type { EventScopeInput } from '@agent/core/event-scope';
import { withExecutionContext } from '@agent/core/authority';
import { getRegisteredEnvBool, getRegisteredEnvText } from '@agent/core/foundation';
import type { HeadlessViewerScope } from '@agent/core/headless-surface-contract';
import type { SurfaceAuthorizationContext } from '@agent/core/surface-authorization';
import { toWireError } from '@agent/core/wire-error';

const CONCIERGE_RATE_LIMIT_WINDOW_MS = 60_000;
const CONCIERGE_RATE_LIMIT_GET = 180;
const CONCIERGE_RATE_LIMIT_MUTATION = 60;
const conciergeRateLimitStore = new Map<string, { count: number; windowStart: number }>();
const conciergeRateLimitedRequests = new WeakSet<object>();

export interface ConciergeViewerContext {
  role: ChronosAccessRole;
  tenantSlugs: string[] | 'all';
  organizationIds: string[] | 'all';
  projectIds: string[] | 'all';
  tierAccess: Array<'personal' | 'confidential' | 'public'>;
  source: 'token' | 'loopback' | 'anonymous';
  principalId?: string;
}

export class ConciergeViewerError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'ConciergeViewerError';
  }
}

function isLoopbackRequest(req: NextRequest): boolean {
  const directIp = (req as NextRequest & { ip?: string }).ip;
  const peerIp =
    directIp ||
    (getRegisteredEnvBool('KYBERION_TRUST_PROXY') === true
      ? req.headers.get('x-real-ip')?.trim() ||
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      : undefined);
  return peerIp === '127.0.0.1' || peerIp === '::1' || peerIp === '::ffff:127.0.0.1';
}

function bearerToken(req: NextRequest): string | null {
  return extractSurfaceBearerToken(req.headers.get('authorization')) || null;
}

function conciergeClientAddress(req: NextRequest): string {
  const directIp = (req as NextRequest & { ip?: string }).ip?.trim();
  if (directIp) return directIp;
  if (getRegisteredEnvBool('KYBERION_TRUST_PROXY') === true) {
    return (
      req.headers.get('x-real-ip')?.trim() ||
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown'
    );
  }
  return 'unknown';
}

function conciergeRateLimitKey(req: NextRequest): string {
  const token = bearerToken(req);
  const principal = token ? `token:${token}` : `ip:${conciergeClientAddress(req)}`;
  return `${principal}:${String(req.method || 'GET').toUpperCase()}`;
}

export function checkConciergeRateLimit(
  req: NextRequest,
  options?: { limit?: number; windowMs?: number }
): { ok: boolean; retryAfterSeconds?: number } {
  const method = String(req.method || 'GET').toUpperCase();
  const limit =
    options?.limit ??
    (method === 'GET' || method === 'HEAD'
      ? CONCIERGE_RATE_LIMIT_GET
      : CONCIERGE_RATE_LIMIT_MUTATION);
  const windowMs = options?.windowMs ?? CONCIERGE_RATE_LIMIT_WINDOW_MS;
  const now = Date.now();
  const key = conciergeRateLimitKey(req);
  const current = conciergeRateLimitStore.get(key);
  const expired = !current || now - current.windowStart >= windowMs;
  const windowStart = expired ? now : current.windowStart;
  const count = expired ? 1 : current.count + 1;
  conciergeRateLimitStore.set(key, { count, windowStart });
  if (count <= limit) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - windowStart)) / 1000)),
  };
}

/** Apply Concierge's request limit once, even when mutation auth resolves the viewer twice. */
export function guardConciergeRequest(req: NextRequest): NextResponse | null {
  if (conciergeRateLimitedRequests.has(req)) return null;
  conciergeRateLimitedRequests.add(req);
  const result = checkConciergeRateLimit(req);
  if (result.ok) return null;
  return NextResponse.json(
    { ok: false, error: 'Concierge rate limit exceeded. Try again later.' },
    {
      status: 429,
      headers: result.retryAfterSeconds
        ? { 'Retry-After': String(result.retryAfterSeconds) }
        : undefined,
    }
  );
}

function registrations(): ChronosTokenRegistration[] | null {
  try {
    return readChronosTokenRegistrations();
  } catch {
    throw new ConciergeViewerError(401, 'Concierge viewer token registry is unavailable.');
  }
}

type ConciergeTier = ConciergeViewerContext['tierAccess'][number];

/** Concierge roles currently expose public/confidential; personal remains masked. */
function maskPersonalTier(tiers: readonly ConciergeTier[]): ConciergeViewerContext['tierAccess'] {
  return tiers.filter((tier) => tier !== 'personal');
}

/** Concierge roles currently expose public/confidential; personal remains masked. */
export function defaultTierAccess(role: ChronosAccessRole): ConciergeViewerContext['tierAccess'] {
  return maskPersonalTier(defaultSurfaceViewerTierAccess(role));
}

function serverTenant(): string {
  try {
    return (
      getRegisteredEnvText('KYBERION_TENANT')?.trim() ||
      String(currentScope().tenant_slug || '').trim()
    );
  } catch {
    return '';
  }
}

/**
 * A registration can narrow a role, but never widen it — and never reach `personal`:
 * an explicit request for it is denied, and the role default is masked down.
 */
export function resolveTierAccess(
  role: ChronosAccessRole,
  requested?: readonly ConciergeTier[]
): ConciergeViewerContext['tierAccess'] {
  try {
    if (requested?.includes('personal')) {
      throw new Error(`viewer tier scope exceeds the ${role} role policy.`);
    }
    const resolved = maskPersonalTier(resolveSurfaceViewerTierAccess(role, requested));
    if (!resolved.length) {
      throw new Error(`viewer tier scope exceeds the ${role} role policy.`);
    }
    return resolved;
  } catch (error) {
    throw new ConciergeViewerError(
      403,
      error instanceof Error
        ? `Concierge ${error.message}`
        : `Concierge viewer tier scope exceeds the ${role} role policy.`
    );
  }
}

export function resolveConciergeViewerContext(req: NextRequest): ConciergeViewerContext {
  const local = isLoopbackRequest(req);
  const token = bearerToken(req);
  const registry = token ? registrations() : null;
  const apiToken = getRegisteredEnvText('KYBERION_API_TOKEN');
  const localadminToken = getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN');
  try {
    return resolveSurfaceViewerScope({
      token,
      local,
      serverTenant: serverTenant(),
      registrations: registry,
      apiToken,
      localadminToken,
      allowLoopback: true,
      loopbackRole: 'localadmin',
      loopbackUsesServerTenant: true,
      allowPersonalTier: false,
      principalIds: {
        localadmin: 'human:concierge-localadmin',
        readonly: 'human:concierge-token',
      },
    });
  } catch (error) {
    if (!(error instanceof SurfaceViewerScopeError)) throw error;
    let message = error.message;
    if (message === 'Unknown viewer token.') message = 'Unknown Concierge viewer token.';
    if (message.includes('Remote viewer access requires')) {
      message = 'Remote Concierge access requires server-side KYBERION_TENANT scope.';
    }
    if (message === 'A viewer principal is required.') {
      message = 'A Concierge viewer principal is required.';
    }
    throw new ConciergeViewerError(error.status, message);
  }
}

export function resolveConciergeViewer(
  req: NextRequest
):
  | { context: ConciergeViewerContext; response?: never }
  | { context?: never; response: NextResponse } {
  const rateLimitResponse = guardConciergeRequest(req);
  if (rateLimitResponse) return { response: rateLimitResponse };
  try {
    return { context: resolveConciergeViewerContext(req) };
  } catch (error) {
    return {
      response: conciergeErrorResponse(
        error,
        error instanceof ConciergeViewerError ? error.status : 401
      ),
    };
  }
}

export function narrowConciergeScope(
  viewer: ConciergeViewerContext,
  query: { tenant?: string | null; organizationId?: string | null; projectId?: string | null }
) {
  try {
    return narrowSurfaceViewerScope(viewer, query);
  } catch (error) {
    throw new ConciergeViewerError(
      403,
      error instanceof Error ? `Concierge ${error.message}` : 'Concierge viewer scope denied'
    );
  }
}

export function conciergeHeadlessScope(viewer: ConciergeViewerContext): HeadlessViewerScope {
  return {
    role: viewer.role,
    ...(viewer.principalId ? { principal_id: viewer.principalId } : {}),
    tenant_slugs: viewer.tenantSlugs,
    organization_ids: viewer.organizationIds,
    project_ids: viewer.projectIds,
    tier_access: maskPersonalTier(viewer.tierAccess),
  };
}

export function toSurfaceAuthorizationContext(
  viewer: ConciergeViewerContext
): SurfaceAuthorizationContext {
  return {
    role: viewer.role,
    tenantSlugs: viewer.tenantSlugs,
    organizationIds: viewer.organizationIds,
    projectIds: viewer.projectIds,
    tierAccess: maskPersonalTier(viewer.tierAccess),
    principalId: viewer.principalId,
    source: viewer.source,
  };
}

/**
 * Build the non-personal scope used by Concierge conversation execution.
 * Viewer tier access is authoritative; the request body must not choose a
 * stronger tier. A multi-tenant localadmin session cannot safely select one
 * confidential tenant, so it receives a public/system scope instead.
 */
export function conciergeConversationScope(viewer: ConciergeViewerContext): EventScopeInput {
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  const tier = viewer.tierAccess.includes('confidential')
    ? 'confidential'
    : viewer.tierAccess.includes('public')
      ? 'public'
      : undefined;
  return tenant && tier
    ? { scope_kind: 'tenant', tier, tenant_slug: tenant }
    : { scope_kind: 'system', tier: 'public' };
}

export function withConciergeViewerContext<T>(viewer: ConciergeViewerContext, fn: () => T): T {
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  return withExecutionContext(
    viewer.role === 'localadmin' ? 'concierge_localadmin' : 'concierge_operator',
    fn,
    undefined,
    tenant
  );
}

export function conciergeErrorResponse(error: unknown, statusOverride?: number): NextResponse {
  const status = statusOverride || (error instanceof ConciergeViewerError ? error.status : 500);
  const safe = toWireError({
    status,
    message: error instanceof Error ? error.message : String(error),
  });
  return NextResponse.json(
    {
      ok: false,
      error: safe.message,
      error_code: safe.code,
      correlation_id: safe.correlation_id,
    },
    { status }
  );
}
