import { NextRequest, NextResponse } from 'next/server';
import {
  executeCompanySetup,
  type CompanySetupCommand,
} from '@agent/core/organization/company-setup-workflow';
import { SurfaceManagementError } from '@agent/core/surface/surface-management-mutations';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { managementAuthorization } from '../../../../lib/management-server';
import {
  conciergeCredential,
  guardConciergeRequest,
  resolveConciergeViewer,
} from '../../../../lib/viewer-context';
import { readRequestObject } from '../../../../lib/request-input';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const allowed: Record<string, readonly string[]> = {
  preview_company: ['vertical', 'firstWork'],
  register_company: ['vertical', 'firstWork', 'reviewDigest'],
  probe: [],
  request_activation: [],
  apply_activation: ['requestId'],
  preview_first_work: [],
  apply_first_work: ['reviewDigest'],
};
function failure(error: unknown) {
  if (error instanceof SurfaceManagementError)
    return NextResponse.json(
      { ok: false, error_code: error.code, error: error.message },
      { status: error.status, headers }
    );
  const text = error instanceof Error ? error.message : '';
  const code = text.includes('APPROVAL_HUMAN_PROOF_REQUIRED')
    ? 'human_approval_required'
    : text.includes('APPROVAL')
      ? 'approval_not_ready'
      : text.includes('TENANT_ACTIVATION')
        ? 'activation_not_ready'
        : 'company_setup_unavailable';
  return NextResponse.json(
    {
      ok: false,
      error_code: code,
      error:
        'Company setup could not continue. Refresh its state and review the required next step.',
    },
    { status: 409, headers }
  );
}
function principal(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response || !resolved.context.principal)
    throw new SurfaceManagementError(
      'unauthenticated',
      401,
      'Sign in with an active owner account.'
    );
  return resolved.context.principal;
}
export async function GET(req: NextRequest) {
  const limited = guardConciergeRequest(req);
  if (limited) return limited;
  try {
    const query = req.nextUrl.searchParams;
    for (const key of query.keys())
      if (key !== 'tenant' || query.getAll(key).length !== 1)
        throw new SurfaceManagementError('invalid_input', 400, 'Select one tenant.');
    const auth = managementAuthorization(req, query.get('tenant') ?? undefined);
    return NextResponse.json(
      await executeCompanySetup(auth, { action: 'status' }, principal(req)),
      { headers }
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  if (
    conciergeCredential(req).source !== 'header' &&
    !isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') ?? new URL(req.url).host,
    })
  )
    return NextResponse.json(
      { ok: false, error_code: 'forbidden', error: 'Cross-origin request denied.' },
      { status: 403, headers }
    );
  try {
    const parsed = await readRequestObject(req, 'request body', [
      'action',
      'tenantSlug',
      'vertical',
      'firstWork',
      'reviewDigest',
      'requestId',
    ]);
    if (!parsed.ok)
      throw new SurfaceManagementError('invalid_input', 400, 'Invalid company setup request.');
    const body = parsed.body;
    if (
      typeof body.action !== 'string' ||
      !Object.hasOwn(allowed, body.action) ||
      typeof body.tenantSlug !== 'string'
    )
      throw new SurfaceManagementError(
        'invalid_input',
        400,
        'Select a tenant and supported setup action.'
      );
    for (const key of Object.keys(body))
      if (
        !['action', 'tenantSlug', ...allowed[body.action]].includes(key) ||
        typeof body[key] !== 'string'
      )
        throw new SurfaceManagementError('invalid_input', 400, 'Unexpected company setup field.');
    const { tenantSlug, ...command } = body;
    const auth = managementAuthorization(req, tenantSlug as string);
    return NextResponse.json(
      await executeCompanySetup(auth, command as unknown as CompanySetupCommand, principal(req)),
      { headers }
    );
  } catch (error) {
    return failure(error);
  }
}
