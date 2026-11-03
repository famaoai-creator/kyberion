import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import {
  authorizeHeadlessOperation,
  headlessEnvelope,
  headlessErrorResponse,
} from '../../../../../lib/ops/headless-response';
import { readHeadlessWorkItems } from '../../../../../lib/ops/headless-projections';
import { resolveOpsViewerForRequest } from '../../../../../lib/ops/ops-viewer';
import { readChronosOptionalStringParam } from '../../../../../lib/ops/request-input';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const access = requireOpsAccess(req, 'readonly');
  if (access) return access;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.work_items.read', {
      tenantSlug: readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant')),
      organizationId: readChronosOptionalStringParam(
        req.nextUrl.searchParams.get('organization_id')
      ),
      projectId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id')),
    });
    const projection = readHeadlessWorkItems(resolvedViewer.context, {
      tenant: readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant')),
      organizationId: readChronosOptionalStringParam(
        req.nextUrl.searchParams.get('organization_id')
      ),
      projectId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id')),
      missionId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('mission_id')),
      scope: readChronosOptionalStringParam(req.nextUrl.searchParams.get('scope')),
      view: readChronosOptionalStringParam(req.nextUrl.searchParams.get('view')),
    });
    return NextResponse.json(headlessEnvelope('work-items', projection, resolvedViewer.context));
  } catch (error) {
    return headlessErrorResponse(error);
  }
}
