import { NextResponse, type NextRequest } from 'next/server';
import { fixedWindowLimiter } from '@agent/core/foundation/rate-limit';
import { loadRuntimeControlPolicy } from '@agent/core/runtime-control-policy';
import { currentScope } from '@agent/core/scope-context';
import {
  CHRONOS_TOKEN_REGISTRY_READER_ROLE,
  readChronosTokenRegistrations,
  type ChronosTokenRegistration,
} from '@agent/core/chronos-access-registry';
import {
  defaultSurfaceViewerTierAccess,
  narrowSurfaceViewerScope,
  SurfaceViewerScopeError,
  resolveSurfaceViewerTierAccess,
  extractSurfaceBearerToken,
} from '@agent/core/surface/surface-mutation-guard';
import {
  extractSurfaceCredential,
  type SurfaceCredentialSource,
} from '@agent/core/surface/surface-session-cookie';
import { resolveAuthnSurfaceViewerScope } from '@agent/core/surface/surface-authn';
import { anonymousLoopbackAllowed } from '@agent/core/surface/installation-owner-access';
import type { ResolvedPrincipal } from '@agent/core/authn-principal-resolver';
import type { EventScopeInput } from '@agent/core/event-scope';
import { withExecutionContext, withStoreGrant } from '@agent/core/authority';
import { getRegisteredEnvBool, getRegisteredEnvText } from '@agent/core/foundation';
import type { HeadlessViewerScope } from '@agent/core/headless-surface-contract';
import {
  SurfaceAuthorizationError,
  type SurfaceAuthorizationContext,
  type SurfaceViewerRole,
} from '@agent/core/surface/surface-authorization';
import { toWireError } from '@agent/core/contracts/wire-error';
import { conciergePeerAddress, isLoopbackPeer } from './loopback-peer';
import { conciergeExecutionRole } from './viewer-execution-role';

let conciergeRateLimiter: ReturnType<typeof fixedWindowLimiter> | undefined;
const conciergeRateLimitedRequests = new WeakSet<object>();

export interface ConciergeViewerContext {
  /** Optional server-resolved replacement set; an empty set grants no read. */
  permissions?: SurfaceAuthorizationContext['permissions'];
  role: SurfaceViewerRole;
  tenantSlugs: string[] | 'all';
  organizationIds: string[] | 'all';
  projectIds: string[] | 'all';
  tierAccess: Array<'personal' | 'confidential' | 'public'>;
  source: 'token' | 'loopback' | 'anonymous';
  principalId?: string;
  /** FD-07: the matched chronos-access registration's label, when a token registration matched. */
  registrationLabel?: string;
  /** FD-07: the matched registration's member_id, when it declares one. */
  memberId?: string;
  /** The seam-resolved principal (authz policy-engine input). */
  principal?: ResolvedPrincipal;
  /**
   * Set only by the system selection (`tenantSlugs: []`): reads also admit
   * records that carry no tenant. Routes that ignore it show nothing.
   */
  includeUntenanted?: boolean;
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

/**
 * The request credential: an Authorization bearer wins, then the browser
 * `kyberion_session` cookie. `source` lets callers apply the CSRF check to
 * cookie-borne unsafe requests.
 */
export function conciergeCredential(req: NextRequest): {
  token: string | null;
  source: SurfaceCredentialSource;
} {
  const header = extractSurfaceBearerToken(req.headers.get('authorization'));
  if (header) return { token: header, source: 'header' };
  const { token, source } = extractSurfaceCredential({
    authorization: null,
    cookie: req.headers.get('cookie'),
  });
  return { token: token || null, source };
}

function bearerToken(req: NextRequest): string | null {
  return conciergeCredential(req).token;
}

export function conciergeClientAddress(req: NextRequest): string {
  const directIp = conciergePeerAddress(req)?.trim();
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
  options?: {
    limit?: number;
    windowMs?: number;
    /** Overrides the credential/address key (its method suffix is kept). */
    key?: string;
  }
): { ok: boolean; retryAfterSeconds?: number } {
  const policy = loadRuntimeControlPolicy().concierge;
  conciergeRateLimiter ??= fixedWindowLimiter({
    windowMs: policy.window_ms,
    maxKeys: policy.max_keys,
    eviction: 'deny',
  });
  const method = String(req.method || 'GET').toUpperCase();
  const limit =
    options?.limit ??
    (method === 'GET' || method === 'HEAD' ? policy.read_limit : policy.mutation_limit);
  const windowMs = options?.windowMs ?? policy.window_ms;
  const now = Date.now();
  const key = options?.key ? `${options.key}:${method}` : conciergeRateLimitKey(req);
  const decision = conciergeRateLimiter.take(key, limit, now, windowMs);
  if (decision.allowed === true) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
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
    // FD-07 finding: `chronos-access.json` lives under the personal tier —
    // reading it (needed to resolve ANY bearer-token viewer, not just a
    // member-bound one) requires an authorized execution context, same as
    // tenant/member profiles. This resolver runs before any other
    // `withExecutionContext` call in the request (it decides the viewer that
    // later calls use), so it must establish its own short-lived one here —
    // without it, a corrupt/unreadable-looking `{}` is returned silently and
    // every token viewer is rejected as unknown.
    // TR-01: the narrow reader role (only grant: chronos-access.json) instead
    // of the broad sovereign_concierge.
    return withStoreGrant(
      CHRONOS_TOKEN_REGISTRY_READER_ROLE,
      () => readChronosTokenRegistrations(),
      { tenantSlug: '' }
    );
  } catch {
    throw new ConciergeViewerError(401, 'Concierge viewer token registry is unavailable.');
  }
}

type ConciergeTier = ConciergeViewerContext['tierAccess'][number];

/** Concierge roles currently expose public/confidential; personal remains masked. */
export function maskPersonalTier(
  tiers: readonly ConciergeTier[]
): ConciergeViewerContext['tierAccess'] {
  return tiers.filter((tier) => tier !== 'personal');
}

/** Concierge roles currently expose public/confidential; personal remains masked. */
export function defaultTierAccess(role: SurfaceViewerRole): ConciergeViewerContext['tierAccess'] {
  return maskPersonalTier(defaultSurfaceViewerTierAccess(role));
}

/** The server-bound tenant (`KYBERION_TENANT`, else the persisted scope); '' when unbound. */
export function serverTenant(): string {
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
  role: SurfaceViewerRole,
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

/**
 * A credential-less loopback request is the local operator (localadmin) only
 * while bootstrap is open — first-run setup unclaimed and no owner able to
 * sign in — or with the default-off KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK
 * escape hatch. Once an owner is bound, other OS users and local processes
 * must sign in like anyone else: the request resolves to 401.
 */
export function resolveConciergeViewerContext(req: NextRequest): ConciergeViewerContext {
  const local = isLoopbackPeer(req);
  const token = bearerToken(req);
  const allowLoopback = local && (token !== null || anonymousLoopbackAllowed());
  const registry = token ? registrations() : null;
  const apiToken = getRegisteredEnvText('KYBERION_API_TOKEN');
  const localadminToken = getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN');
  try {
    const { scope, principal } = resolveAuthnSurfaceViewerScope({
      token,
      local,
      serverTenant: serverTenant(),
      registrations: registry,
      apiToken,
      localadminToken,
      allowLoopback,
      loopbackRole: 'localadmin',
      loopbackUsesServerTenant: true,
      allowPersonalTier: false,
      principalIds: {
        localadmin: 'human:concierge-localadmin',
        readonly: 'human:concierge-token',
      },
      surface: 'concierge',
    });
    return { ...scope, principal };
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

type ViewerResolution = { context: ConciergeViewerContext } | { error: unknown };
const resolvedViewers = new WeakMap<object, ViewerResolution>();

/**
 * Resolve the viewer once per request object and remember the outcome (a
 * failure is remembered too and thrown again). Opt-in: only a caller that
 * runs several gates over one request uses it (the operations gates do).
 * `resolveConciergeViewer` then reuses that outcome instead of resolving the
 * same request again; a request that never came through here is resolved
 * fresh on every call, as before.
 */
export function resolveConciergeViewerContextOnce(req: NextRequest): ConciergeViewerContext {
  let resolution = resolvedViewers.get(req);
  if (!resolution) {
    try {
      resolution = { context: resolveConciergeViewerContext(req) };
    } catch (error) {
      resolution = { error };
    }
    resolvedViewers.set(req, resolution);
  }
  if ('error' in resolution) throw resolution.error;
  return resolution.context;
}

export function resolveConciergeViewer(
  req: NextRequest
):
  | { context: ConciergeViewerContext; response?: never }
  | { context?: never; response: NextResponse } {
  const rateLimitResponse = guardConciergeRequest(req);
  if (rateLimitResponse) return { response: rateLimitResponse };
  try {
    return {
      context: resolvedViewers.has(req)
        ? resolveConciergeViewerContextOnce(req)
        : resolveConciergeViewerContext(req),
    };
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

/**
 * The one projection from a viewer to the shared authorization context, for
 * every Concierge route including the operations console (`ops-viewer.ts`
 * delegates here). It never widens and never drops a scope field: the
 * personal tier is masked, and `includeUntenanted` is carried so the system
 * selection keeps its company-less records in every reader of the context.
 */
export function toSurfaceAuthorizationContext(
  viewer: ConciergeViewerContext
): SurfaceAuthorizationContext {
  return {
    ...(viewer.permissions !== undefined ? { permissions: viewer.permissions } : {}),
    role: viewer.role,
    tenantSlugs: viewer.tenantSlugs,
    organizationIds: viewer.organizationIds,
    projectIds: viewer.projectIds,
    tierAccess: maskPersonalTier(viewer.tierAccess),
    principalId: viewer.principalId,
    source: viewer.source,
    ...(viewer.principal ? { principal: viewer.principal } : {}),
    ...(viewer.memberId ? { memberId: viewer.memberId } : {}),
    ...(viewer.includeUntenanted ? { includeUntenanted: true } : {}),
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
  return withExecutionContext(conciergeExecutionRole(viewer.role), fn, undefined, tenant);
}

/**
 * The status an error carries when it is an authorization failure: the viewer
 * error itself, or one of the shared scope / operation denials it wraps.
 */
export function viewerErrorStatus(error: unknown): 401 | 403 | undefined {
  return error instanceof ConciergeViewerError ||
    error instanceof SurfaceViewerScopeError ||
    error instanceof SurfaceAuthorizationError
    ? error.status
    : undefined;
}

/**
 * What the wire code / message of an error response is classified from:
 * - `response-status` — the response status plus the error message. Every
 *   Concierge route outside the operations console.
 * - `error-object` — the error itself: its own `code` / `status` / message,
 *   whatever status the route answers with. The operations console, so an
 *   errno (`EBUSY`), a `session_locked` code or a lifecycle conflict answered
 *   409 keeps the code its error carries.
 * The two paths classified this way before they shared this helper; the
 * choice is stated by the caller, not inferred.
 */
export type ViewerErrorClassification = 'response-status' | 'error-object';

/**
 * The wire body `conciergeErrorResponse` sends (so a caller can log its
 * correlation id). Status: the override, else the status of an authorization
 * failure, else 500. This is the one viewer error response; the operations
 * console's `viewerErrorResponse` calls it with its own fallback status and
 * the `error-object` classification.
 */
export function conciergeErrorBody(
  error: unknown,
  statusOverride?: number,
  classification: ViewerErrorClassification = 'response-status'
): {
  status: number;
  body: { ok: false; error: string; error_code: string; correlation_id: string };
} {
  const status = statusOverride || viewerErrorStatus(error) || 500;
  const safe = toWireError(
    classification === 'error-object'
      ? error
      : { status, message: error instanceof Error ? error.message : String(error) }
  );
  return {
    status,
    body: {
      ok: false,
      error: safe.message,
      error_code: safe.code,
      correlation_id: safe.correlation_id,
    },
  };
}

export function conciergeErrorResponse(
  error: unknown,
  statusOverride?: number,
  classification: ViewerErrorClassification = 'response-status'
): NextResponse {
  const { status, body } = conciergeErrorBody(error, statusOverride, classification);
  return NextResponse.json(body, { status });
}
