import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  authorizeHeadlessOperation,
  headlessEnvelope,
  headlessErrorResponse,
} from '../../../../lib/headless-response';
import { readHeadlessWorkItems } from '../../../../lib/headless-projections';
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
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.work_items.read', {
      tenantSlug: req.nextUrl.searchParams.get('tenant') || undefined,
      organizationId: req.nextUrl.searchParams.get('organization_id') || undefined,
      projectId: req.nextUrl.searchParams.get('project_id') || undefined,
    });
    const projection = readHeadlessWorkItems(resolvedViewer.context, {
      tenant: req.nextUrl.searchParams.get('tenant') || undefined,
      organizationId: req.nextUrl.searchParams.get('organization_id') || undefined,
      projectId: req.nextUrl.searchParams.get('project_id') || undefined,
      missionId: req.nextUrl.searchParams.get('mission_id') || undefined,
      scope: req.nextUrl.searchParams.get('scope') || undefined,
      view: req.nextUrl.searchParams.get('view') || undefined,
    });
    return NextResponse.json(headlessEnvelope('work-items', projection, resolvedViewer.context));
  } catch (error) {
    return headlessErrorResponse(error);
  }
}
