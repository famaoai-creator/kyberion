/**
 * 初めての仕事 (`/first-job`): the gate in front of every `/api/first-job*`
 * route, moved from presence-studio `first-job-routes.ts` (Kyberion server
 * phase 2). The diagnostic is a bounded local guide for the owner of this
 * machine, so each Studio check is kept exactly:
 *
 *   Studio `req.socket.remoteAddress` is loopback
 *     → `isLoopbackPeer(req)`: the local server's in-process peer proof
 *       (`server/local-peer.ts`), never `req.ip` or a forwarded header.
 *   Studio `localRequestOrigin(req)`: a bare loopback `Host`, also on reads
 *     (DNS-rebinding defence) → {@link firstJobLocalOrigin}, the same parse.
 *   Studio `resolvePresenceStudioViewerContext` + `requirePresenceStudioLocalAdmin`
 *     ("every credential-free loopback request is localadmin")
 *     → the Concierge viewer, then {@link resolveConciergeInstallationAccess}:
 *       the signed-in installation owner on that attested peer, or a
 *       credential-free loopback request only while bootstrap is open or the
 *       anonymous-loopback escape hatch is on. Never `viewer.source`.
 *   Studio `sameOrigin(req)` for every POST → {@link isFirstJobSameOrigin},
 *     the same two checks against the local origin.
 *   Studio `credentialFor(req)` → {@link firstJobCredential}, the same call.
 *     The Concierge viewer reads the credential with its own parser
 *     (`conciergeCredential`); a request on which the two disagree (e.g. a
 *     lowercase `bearer` header beside a session cookie) is refused, so the
 *     identity that passed the gate is the one the shared logic verifies.
 *
 * Concierge's own refusals (rate limit, the shared write guard) carry no
 * effect, so they become first-job refusals that are safe to retry.
 *
 * Once admitted, the shared first-job logic receives the same server-owned
 * local diagnostic viewer Studio passed (`toFrontDeskViewerScope` of a
 * loopback localadmin). The installed diagnostic mapping
 * (`scripts/onboarding_first_job.ts`) is bound to exactly that principal, and
 * the approval and recovery writers re-verify the browser session's member
 * against the owner on every call; nothing here is taken from the request.
 */
import type { NextRequest } from 'next/server';
import type { SurfaceViewerScope } from '@agent/core/surface/surface-mutation-guard';
import {
  extractSurfaceCredential,
  isSameOriginMutation,
} from '@agent/core/surface/surface-session-cookie';
import { isLoopbackAddress } from '../../server/local-peer.ts';
import { requireConciergeMutationAccess } from './api-guard';
import { resolveConciergeInstallationAccess } from './installation-access';
import { isLoopbackPeer } from './loopback-peer';
import { conciergeCredential, resolveConciergeViewer, serverTenant } from './viewer-context';

/**
 * The local diagnostic operator the installed mapping names
 * (`scripts/onboarding_first_job.ts` `PRINCIPAL`). It identifies "the
 * operator of this machine" for the diagnostic charter, not a credential.
 */
export const FIRST_JOB_LOCAL_OPERATOR_PRINCIPAL_ID = 'human:presence-studio-localadmin';

export type FirstJobGateCode =
  'first_job_access_denied' | 'first_job_origin_denied' | 'first_job_rate_limited';

export interface FirstJobGateDenial {
  status: number;
  error: FirstJobGateCode;
  /** Set for Concierge's own refusals: no effect happened, so a retry is safe. */
  retrySafe?: true;
  /** The original `Retry-After` of a rate-limit refusal. */
  retryAfter?: string;
}

export type FirstJobGate =
  | { viewer: SurfaceViewerScope; credential: string; denial?: never }
  | { viewer?: never; credential?: never; denial: FirstJobGateDenial };

/** Concierge's own refusal as a first-job refusal, keeping its status (no effect happened). */
function wrapConciergeRefusal(response: Response, fromWriteGuard: boolean): FirstJobGate {
  const status = response.status;
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  const error: FirstJobGateCode =
    status === 429
      ? 'first_job_rate_limited'
      : fromWriteGuard && status === 403
        ? 'first_job_origin_denied'
        : 'first_job_access_denied';
  return { denial: { status, error, retrySafe: true, ...(retryAfter ? { retryAfter } : {}) } };
}

/**
 * Studio `localRequestOrigin`: the origin the browser used, only when the
 * `Host` is a bare loopback authority. The attested local listener is plain
 * HTTP (`server/local-server.ts`), as Studio's unencrypted socket was.
 */
export function firstJobLocalOrigin(host: string | null): string | undefined {
  if (typeof host !== 'string') return undefined;
  try {
    const expected = new URL('http://' + host);
    const hostname = expected.hostname.replace(/^\[|\]$/g, '');
    if (
      expected.username ||
      expected.password ||
      !(hostname === 'localhost' || isLoopbackAddress(hostname))
    )
      return undefined;
    return expected.origin;
  } catch {
    return undefined;
  }
}

/** Studio `sameOrigin`: a same-site POST whose Origin/Referer is the local origin. */
export function isFirstJobSameOrigin(req: NextRequest): boolean {
  const host = req.headers.get('host');
  if (
    !isSameOriginMutation({
      method: 'POST',
      headers: req.headers,
      expectedHost: String(host || ''),
    })
  )
    return false;
  const source = req.headers.get('origin') || req.headers.get('referer');
  if (typeof source !== 'string') return false;
  try {
    return new URL(source).origin === firstJobLocalOrigin(host);
  } catch {
    return false;
  }
}

/** Studio `credentialFor`: the bearer header, else the browser session cookie. */
export function firstJobCredential(req: NextRequest): string {
  return extractSurfaceCredential({
    authorization: req.headers.get('authorization'),
    cookie: req.headers.get('cookie'),
  }).token;
}

/**
 * The server-owned diagnostic viewer (Studio `toFrontDeskViewerScope`,
 * public-only). Its tenant is the server binding Concierge uses for its own
 * loopback viewer; unbound, every tenant, which the installed mapping narrows.
 */
function localDiagnosticViewer(): SurfaceViewerScope {
  const tenant = serverTenant();
  return {
    role: 'localadmin',
    source: 'loopback',
    principalId: FIRST_JOB_LOCAL_OPERATOR_PRINCIPAL_ID,
    tenantSlugs: tenant ? [tenant] : 'all',
    organizationIds: 'all',
    projectIds: 'all',
    // The diagnostic narrows to public itself; never hand it more.
    tierAccess: ['public'],
  };
}

/**
 * Admit one `/api/first-job*` request, in Studio's order: peer, Host, viewer
 * and owner, then (POST) same origin. A refused request learns nothing else.
 */
export function resolveFirstJobGate(req: NextRequest, mutation: boolean): FirstJobGate {
  const denied = { denial: { status: 403, error: 'first_job_access_denied' } } as const;
  if (!isLoopbackPeer(req)) return denied;
  if (!firstJobLocalOrigin(req.headers.get('host'))) return denied;
  // The viewer and the shared logic must see the same credential.
  if ((conciergeCredential(req).token ?? '') !== firstJobCredential(req)) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) {
    const status = resolved.response.status;
    // The viewer's own message never reaches the page: only the code.
    return status === 401 || status === 403
      ? { denial: { status, error: 'first_job_access_denied' } }
      : wrapConciergeRefusal(resolved.response, false);
  }
  const decision = resolveConciergeInstallationAccess(
    resolved.context,
    mutation ? 'write' : 'read',
    req
  );
  if (!decision.allowed)
    return { denial: { status: decision.status, error: 'first_job_access_denied' } };
  if (mutation && !isFirstJobSameOrigin(req))
    return { denial: { status: 403, error: 'first_job_origin_denied' } };
  // The shared Concierge write guard, after the route's own refusals (as on
  // every other Concierge mutation); its refusal becomes a coded one.
  if (mutation) {
    const guarded = requireConciergeMutationAccess(req);
    if (guarded) return wrapConciergeRefusal(guarded, true);
  }
  return { viewer: localDiagnosticViewer(), credential: firstJobCredential(req) };
}
