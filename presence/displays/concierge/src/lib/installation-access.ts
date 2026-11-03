/**
 * Concierge adapter for the installation-owner authorization model
 * (`@agent/core/surface/installation-owner-access`). Settings of the whole
 * machine — operator service credentials, the owner's personal profile and
 * avatar, personal onboarding authority — are authorized by who is asking and
 * how strongly they proved it; loopback is only a factor:
 *
 *   read  → the installation owner, any transport
 *   write → the installation owner on a trusted loopback peer, or with a
 *           passkey step-up this session confirmed within five minutes
 *
 * Inputs are server-resolved only: the verified principal on the viewer
 * context, the transport adapter's loopback attestation, and a binding of the
 * presented credential for the step-up lookup.
 */
import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  anonymousLoopbackAllowed,
  recordInstallationAccessAudit,
  resolveInstallationOwnerAccess,
  type InstallationAccessMode,
  type InstallationOwnerDecision,
  type InstallationOwnerGrant,
} from '@agent/core/surface/installation-owner-access';
import { principalFromSurfaceAuthorizationContext } from '@agent/core/surface/surface-authn';
import { extractSurfaceBearerToken } from '@agent/core/surface/surface-mutation-guard';
import { extractSurfaceCredential } from '@agent/core/surface/surface-session-cookie';
import { isLoopbackPeer } from './loopback-peer';
import type { ConciergeViewerContext } from './viewer-context';

/**
 * Binding of the presented credential (bearer or session cookie) for the
 * server-side step-up record. Never the credential itself.
 */
export function conciergeSessionBinding(req: NextRequest): string | undefined {
  // Same precedence as viewer-context `conciergeCredential`: bearer, then cookie.
  const token =
    extractSurfaceBearerToken(req.headers.get('authorization')) ||
    extractSurfaceCredential({ authorization: null, cookie: req.headers.get('cookie') }).token;
  return token
    ? createHash('sha256').update(`concierge-session\n${token}`).digest('base64url')
    : undefined;
}

/** Whether a credential-less loopback request may still act as the local operator. */
export function conciergeAnonymousLoopbackAllowed(): boolean {
  return anonymousLoopbackAllowed();
}

/**
 * Decide installation access for the viewer. A write needs the request (its
 * transport and session); a read without one trusts only what the viewer
 * context proved — a `loopback` viewer exists only for an attested peer.
 */
export function resolveConciergeInstallationAccess(
  viewer: ConciergeViewerContext,
  mode: InstallationAccessMode,
  req?: NextRequest
): InstallationOwnerDecision {
  const trustedLoopback = req ? isLoopbackPeer(req) : viewer.source === 'loopback';
  // A credential-less viewer carries no identity. A credentialed context
  // without its verified principal (hand-built) gets a synthesized one with
  // assurance `none`, which can never be the installation owner.
  const principal =
    viewer.source === 'loopback' || viewer.source === 'anonymous'
      ? null
      : (viewer.principal ??
        principalFromSurfaceAuthorizationContext({
          role: viewer.role,
          tenantSlugs: viewer.tenantSlugs,
          organizationIds: viewer.organizationIds,
          projectIds: viewer.projectIds,
          tierAccess: viewer.tierAccess,
          principalId: viewer.principalId,
          source: viewer.source,
          ...(viewer.memberId ? { memberId: viewer.memberId } : {}),
        }));
  return resolveInstallationOwnerAccess({
    mode,
    principal,
    trustedLoopback,
    ...(req ? { sessionBinding: conciergeSessionBinding(req) } : {}),
  });
}

/** Stable, non-500 refusal: `{ ok: false, error: <code>, error_code: <code> }`. */
export function installationAccessDenied(
  decision: Exclude<InstallationOwnerDecision, InstallationOwnerGrant>
): NextResponse {
  return NextResponse.json(
    { ok: false, error: decision.code, error_code: decision.code },
    { status: decision.status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Audit an installation-scope write (actor, transport, step-up). */
export function auditConciergeInstallationWrite(
  decision: InstallationOwnerDecision,
  operation: string
): boolean {
  return recordInstallationAccessAudit({ surface: 'concierge', operation, decision });
}

/** An admitted write whose audit record could not be written is refused. */
export function installationAuditUnavailable(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: 'installation_audit_unavailable',
      error_code: 'installation_audit_unavailable',
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * Gate one installation-scope request: the grant, or the refusal to return.
 * Writes are audited whether admitted or refused.
 */
export function requireConciergeInstallationAccess(
  viewer: ConciergeViewerContext,
  mode: InstallationAccessMode,
  req: NextRequest,
  operation: string
): { grant: InstallationOwnerGrant; response?: never } | { grant?: never; response: NextResponse } {
  const decision = resolveConciergeInstallationAccess(viewer, mode, req);
  const audited = mode === 'write' ? auditConciergeInstallationWrite(decision, operation) : true;
  if (!decision.allowed) return { response: installationAccessDenied(decision) };
  if (!audited) return { response: installationAuditUnavailable() };
  return { grant: decision };
}
