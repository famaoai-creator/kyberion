import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import {
  headlessEnvelope,
  headlessErrorResponse,
  parseHeadlessLimit,
  authorizeHeadlessOperation,
} from '../../../../../lib/ops/headless-response';
import { readHeadlessCollaboration } from '../../../../../lib/ops/headless-projections';
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
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.collaboration.read', {
      tenantSlug: readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant')),
      organizationId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization')),
      projectId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project')),
    });
    const limit = parseHeadlessLimit(
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('limit')) ?? null,
      100,
      500
    );
    const projection = readHeadlessCollaboration(resolvedViewer.context, {
      tenant: readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant')),
      missionId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('mission')),
      organizationId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization')),
      projectId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project')),
      taskId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('task')),
      sessionId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('session')),
      scopeKind: readChronosOptionalStringParam(req.nextUrl.searchParams.get('scope_kind')),
      limit,
    });
    return NextResponse.json(headlessEnvelope('collaboration', projection, resolvedViewer.context));
  } catch (error) {
    return headlessErrorResponse(error);
  }
}
