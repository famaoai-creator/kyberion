import { NextResponse, type NextRequest } from 'next/server';
import type { OperatorServiceConnectionPrincipal } from '@agent/core/service/operator-service-connection';
import { requireConciergeMutationAccess } from './api-guard';
import { isLoopbackPeer } from './loopback-peer';
import { resolveConciergeViewer } from './viewer-context';

export function operatorServiceError(error: string, status = 400): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Global operator credentials are never member- or proxy-authorized. */
export function resolveOperatorServiceAccess(
  req: NextRequest
):
  | { principal: OperatorServiceConnectionPrincipal; response?: never }
  | { principal?: never; response: NextResponse } {
  if (req.method !== 'GET') {
    const denied = requireConciergeMutationAccess(req);
    if (denied) return { response: denied };
  }
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return { response: operatorServiceError('local_operator_required', 403) };
  const viewer = resolved.context;
  if (
    !isLoopbackPeer(req) ||
    viewer.role !== 'localadmin' ||
    viewer.source !== 'loopback' ||
    !viewer.principalId ||
    viewer.memberId ||
    viewer.registrationLabel ||
    req.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    return { response: operatorServiceError('local_operator_required', 403) };
  }
  return {
    principal: {
      role: viewer.role,
      source: viewer.source,
      principalId: viewer.principalId,
      loopback: true,
    },
  };
}
