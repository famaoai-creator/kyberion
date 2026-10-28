import { NextRequest, NextResponse } from 'next/server';
import { readOAuthOperation } from '@agent/core/oauth-session-store';
import {
  resolveOperatorServiceAccess,
  operatorServiceError,
} from '../../../../lib/operator-service-access';

export const dynamic = 'force-dynamic';

/** Observation only; the callback broker remains the sole completion authority. */
export async function GET(req: NextRequest) {
  const access = resolveOperatorServiceAccess(req);
  if (access.response) return access.response;
  const serviceId = req.nextUrl.searchParams.get('service_id') || '';
  const operationId = req.nextUrl.searchParams.get('operation_id') || '';
  if (!serviceId || !operationId) return operatorServiceError('invalid_operation', 400);
  try {
    const operation = readOAuthOperation(serviceId, operationId, access.principal.principalId);
    if (!operation) return operatorServiceError('operation_unavailable', 404);
    return NextResponse.json({ ok: true, operation }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return operatorServiceError('operation_unavailable', 503);
  }
}
