import { NextResponse, type NextRequest } from 'next/server';
import type { OperatorServiceConnectionPrincipal } from '@agent/core/service/operator-service-connection';
import type { InstallationOwnerGrant } from '@agent/core/surface/installation-owner-access';
import { requireConciergeMutationAccess } from './api-guard';
import {
  auditConciergeInstallationWrite,
  resolveConciergeInstallationAccess,
} from './installation-access';
import { resolveConciergeViewer } from './viewer-context';

export function operatorServiceError(error: string, status = 400): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * Operator service credentials are installation scope: the installation owner
 * reads them from any transport and changes them from a trusted loopback peer
 * or after a passkey step-up (installation-access.ts). GET is a read; every
 * other method is a write and is audited.
 */
export function resolveOperatorServiceAccess(req: NextRequest):
  | {
      principal: OperatorServiceConnectionPrincipal & {
        principalId: string;
        installationGrant: InstallationOwnerGrant;
      };
      response?: never;
    }
  | { principal?: never; response: NextResponse } {
  const mode = req.method === 'GET' ? 'read' : 'write';
  if (mode === 'write') {
    const denied = requireConciergeMutationAccess(req);
    if (denied) return { response: denied };
  }
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return { response: operatorServiceError('installation_owner_required', 403) };
  }
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) {
    // Keep the status (rate limit stays 429, scope refusal stays 403) but
    // replace the body with a fixed, detail-free code.
    const status = resolved.response.status;
    if (status === 429) return { response: resolved.response };
    return {
      response:
        status === 403
          ? operatorServiceError('installation_owner_required', 403)
          : operatorServiceError('authentication_required', 401),
    };
  }
  const viewer = resolved.context;
  const decision = resolveConciergeInstallationAccess(viewer, mode, req);
  const audited =
    mode === 'write'
      ? auditConciergeInstallationWrite(
          decision,
          `operator_service ${req.method} ${req.nextUrl.pathname}`
        )
      : true;
  if (!decision.allowed) return { response: operatorServiceError(decision.code, decision.status) };
  if (!audited) return { response: operatorServiceError('installation_audit_unavailable', 503) };
  const grant = decision;
  return {
    principal: {
      role: viewer.role,
      source: viewer.source === 'loopback' ? 'loopback' : 'token',
      principalId: grant.principalId,
      loopback: grant.transport === 'loopback',
      installationGrant: grant,
    },
  };
}
