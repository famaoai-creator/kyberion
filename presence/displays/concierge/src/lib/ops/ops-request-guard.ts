/**
 * Request gates for the operations console routes (`/api/ops/*`).
 *
 * The former Chronos `api-guard` kept its own token / loopback auto-admin
 * model. Inside Concierge there is one: the access role is the role of the
 * Concierge viewer (`resolveConciergeViewerContext`), the rate limit is
 * Concierge's, and a localadmin mutation goes through
 * `requireConciergeMutationAccess` (CSRF / origin check). What stays specific
 * to the console is the call-site shape: `guardOpsRequest(req) ??
 * requireOpsAccess(req, 'readonly' | 'localadmin')`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { consumeTenantBudget } from '@agent/core/organization/tenant-rate-limiter';
import type { ChronosAccessRole } from '@agent/core/chronos-access-registry';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import { requireConciergeMutationAccess } from '../api-guard';
import {
  conciergeCredential,
  guardConciergeRequest,
  resolveConciergeViewerContext,
  type ConciergeViewerContext,
} from '../viewer-context';

export type OpsAccessRole = ChronosAccessRole;

const UNAUTHORIZED_MESSAGE = 'Unauthorized. Sign in to Concierge or present a viewer token.';
const resolvedViewers = new WeakMap<object, ConciergeViewerContext | null>();

function resolveOpsViewerOnce(req: NextRequest): ConciergeViewerContext | null {
  if (resolvedViewers.has(req)) return resolvedViewers.get(req) ?? null;
  let viewer: ConciergeViewerContext | null = null;
  try {
    viewer = resolveConciergeViewerContext(req);
  } catch {
    viewer = null;
  }
  resolvedViewers.set(req, viewer);
  return viewer;
}

/** The viewer's access role, or null when the request carries no admissible viewer. */
export function resolveOpsAccessRole(req: NextRequest): OpsAccessRole | null {
  return resolveOpsViewerOnce(req)?.role ?? null;
}

/** For routes that already passed the guards. */
export function getOpsAccessRole(req: NextRequest): OpsAccessRole {
  const role = resolveOpsAccessRole(req);
  if (!role) throw new Error('Operations access role was requested before authentication.');
  return role;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: UNAUTHORIZED_MESSAGE }, { status: 401 });
}

function isUnsafeMethod(req: NextRequest): boolean {
  const method = (req.method || 'GET').toUpperCase();
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * A cookie rides along on cross-site requests, so a cookie-borne unsafe
 * request must be same-origin. Header credentials skip the check.
 */
function crossOriginCookieMutation(req: NextRequest): NextResponse | null {
  if (!isUnsafeMethod(req)) return null;
  if (conciergeCredential(req).source !== 'session-cookie') return null;
  if (
    isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') ?? new URL(req.url).host,
    })
  ) {
    return null;
  }
  return NextResponse.json(
    { ok: false, error: 'Forbidden. Cross-origin session request.' },
    { status: 403 }
  );
}

/**
 * Rate limit + admissible viewer + tenant budget, for every operations route.
 *
 * Two buckets, by method:
 *   - Safe reads (GET / HEAD / OPTIONS) are bounded only by Concierge's
 *     per-credential read ceiling (`runtime-control-policy.json`
 *     `concierge.read_limit`, applied by `guardConciergeRequest`). They never
 *     drain the tenant token bucket: that bucket is the reasoning-cost quota
 *     (`tenant-rate-limit-policy.json`), and one `/ops` render issues ~19
 *     reads, so charging reads to it 429'd normal browsing.
 *   - Unsafe methods (mutations, which may start reasoning work) pass the
 *     Concierge mutation ceiling AND consume the tenant budget.
 */
export function guardOpsRequest(req: NextRequest): NextResponse | null {
  const limited = guardConciergeRequest(req);
  if (limited) return limited;
  const viewer = resolveOpsViewerOnce(req);
  if (!viewer) return unauthorized();
  const blocked = crossOriginCookieMutation(req);
  if (blocked) return blocked;
  if (!isUnsafeMethod(req)) return null;
  const tenants = viewer.tenantSlugs === 'all' ? [] : viewer.tenantSlugs;
  const budget = consumeTenantBudget({
    op: 'surface:ops_request',
    ...(tenants.length === 1 ? { tenantSlug: tenants[0] } : {}),
  });
  if (!budget.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Tenant rate limit exceeded.', retry_after_ms: budget.retry_after_ms },
      { status: 429 }
    );
  }
  return null;
}

/**
 * Require a viewer of at least `requiredRole`. `localadmin` writes also pass
 * the Concierge mutation gate (same-origin or configured operator token).
 */
export function requireOpsAccess(
  req: NextRequest,
  requiredRole: OpsAccessRole
): NextResponse | null {
  const role = resolveOpsAccessRole(req);
  if (!role) return unauthorized();
  const blocked = crossOriginCookieMutation(req);
  if (blocked) return blocked;
  if (requiredRole === 'localadmin') {
    if (role !== 'localadmin') {
      return NextResponse.json(
        { ok: false, error: 'Forbidden. This action requires an operator (localadmin) viewer.' },
        { status: 403 }
      );
    }
    if (isUnsafeMethod(req)) return requireConciergeMutationAccess(req);
  }
  return null;
}
