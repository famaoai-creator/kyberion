import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  headlessEnvelope,
  headlessErrorResponse,
  parseHeadlessLimit,
  authorizeHeadlessOperation,
} from '../../../../lib/headless-response';
import { readHeadlessCollaboration } from '../../../../lib/headless-projections';
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
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.collaboration.read', {
      tenantSlug: req.nextUrl.searchParams.get('tenant') || undefined,
      organizationId: req.nextUrl.searchParams.get('organization') || undefined,
      projectId: req.nextUrl.searchParams.get('project') || undefined,
    });
    const limit = parseHeadlessLimit(req.nextUrl.searchParams.get('limit'), 100, 500);
    const projection = readHeadlessCollaboration(resolvedViewer.context, {
      tenant: req.nextUrl.searchParams.get('tenant') || undefined,
      missionId: req.nextUrl.searchParams.get('mission') || undefined,
      organizationId: req.nextUrl.searchParams.get('organization') || undefined,
      projectId: req.nextUrl.searchParams.get('project') || undefined,
      taskId: req.nextUrl.searchParams.get('task') || undefined,
      sessionId: req.nextUrl.searchParams.get('session') || undefined,
      scopeKind: req.nextUrl.searchParams.get('scope_kind') || undefined,
      limit,
    });
    return NextResponse.json(headlessEnvelope('collaboration', projection, resolvedViewer.context));
  } catch (error) {
    return headlessErrorResponse(error);
  }
}
