import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  headlessEnvelope,
  headlessErrorResponse,
  parseHeadlessLimit,
  authorizeHeadlessOperation,
} from '../../../../lib/headless-response';
import { readHeadlessOperatorHome } from '../../../../lib/headless-projections';
import { resolveViewerContextForRequest } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'readonly');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.operator_home.read', {
      tenantSlug: req.nextUrl.searchParams.get('tenant') || undefined,
      organizationId: req.nextUrl.searchParams.get('organization_id') || undefined,
      projectId: req.nextUrl.searchParams.get('project_id') || undefined,
    });
    const limit = parseHeadlessLimit(req.nextUrl.searchParams.get('limit'), 8, 50);
    const summary = readHeadlessOperatorHome(resolvedViewer.context, {
      tenant: req.nextUrl.searchParams.get('tenant') || undefined,
      organizationId: req.nextUrl.searchParams.get('organization_id') || undefined,
      projectId: req.nextUrl.searchParams.get('project_id') || undefined,
      since: req.nextUrl.searchParams.get('since') || undefined,
      limit,
    });
    return NextResponse.json(headlessEnvelope('operator-home', summary, resolvedViewer.context));
  } catch (error) {
    return headlessErrorResponse(error);
  }
}
