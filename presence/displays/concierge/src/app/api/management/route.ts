import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import {
  executeSurfaceManagementMutation,
  SurfaceManagementError,
  type SurfaceManagementCommand,
} from '@agent/core/surface/surface-management-mutations';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { conciergeCredential, guardConciergeRequest } from '../../../lib/viewer-context';
import {
  managementAuthorization,
  managementSnapshot,
  managementContextId,
} from '../../../lib/management-server';
import { readRequestObject } from '../../../lib/request-input';
export const dynamic = 'force-dynamic';
function failure(error: unknown) {
  if (error instanceof SurfaceManagementError)
    return NextResponse.json(
      { ok: false, error: error.message, error_code: error.code },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } }
    );
  return NextResponse.json(
    {
      ok: false,
      error: 'Management is temporarily unavailable.',
      error_code: 'management_unavailable',
    },
    { status: 503 }
  );
}
export async function GET(req: NextRequest) {
  const limited = guardConciergeRequest(req);
  if (limited) return limited;
  try {
    const query = req.nextUrl.searchParams;
    for (const key of query.keys())
      if (
        !['tenant', 'organization_id', 'project_id'].includes(key) ||
        query.getAll(key).length !== 1
      )
        throw new SurfaceManagementError('invalid_input', 400, 'Invalid management selection.');
    const auth = managementAuthorization(req, query.get('tenant') ?? undefined);
    return NextResponse.json(
      await managementSnapshot(
        auth,
        query.get('organization_id') ?? undefined,
        query.get('project_id') ?? undefined
      ),
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  // Every cookie credential needs CSRF protection, including legacy opaque cookies.
  if (
    conciergeCredential(req).source !== 'header' &&
    !isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') ?? new URL(req.url).host,
    })
  )
    return NextResponse.json(
      { ok: false, error: 'Cross-origin management request denied.', error_code: 'forbidden' },
      { status: 403 }
    );
  try {
    const parsed = await readRequestObject(req, 'request body', [
      'tenant',
      'contextId',
      'operation',
      'requestId',
      'organizationId',
      'projectId',
      'expectedVersion',
      'name',
      'purpose',
      'summary',
    ]);
    if (!parsed.ok || typeof parsed.body.tenant !== 'string')
      throw new SurfaceManagementError(
        'invalid_input',
        400,
        'A valid management request and tenant are required.'
      );
    const { tenant, contextId, ...command } = parsed.body;
    const auth = managementAuthorization(req, tenant);
    if (typeof contextId !== 'string' || contextId !== managementContextId(auth))
      throw new SurfaceManagementError(
        'context_changed',
        403,
        'The signed-in owner or management scope changed. Reload before saving.'
      );
    const result = await executeSurfaceManagementMutation(
      auth,
      command as unknown as SurfaceManagementCommand
    );
    return NextResponse.json(
      {
        ok: true,
        result: {
          operation: result.operation,
          organizationId: result.organizationId,
          ...(result.projectId ? { projectId: result.projectId } : {}),
          version: result.version,
          replayed: result.replayed,
          ...(result.auditPending ? { auditPending: true } : {}),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return failure(error);
  }
}
