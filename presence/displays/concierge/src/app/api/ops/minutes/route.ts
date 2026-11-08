import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import {
  readChronosOptionalStringParam,
  readChronosStringParam,
} from '../../../../lib/ops/request-input';
import {
  resolveOpsViewerForRequest,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
  type ViewerContext,
} from '../../../../lib/ops/ops-viewer';
import { listMeetingMinutes, type MinutesScope } from '../../../../lib/ops/meeting-minutes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function minutesScopeFromViewer(
  viewer: ViewerContext,
  narrowing: {
    tenant?: string;
    organizationId?: string;
    projectId?: string;
  }
): MinutesScope {
  return {
    tierAccess: viewer.tierAccess ?? ['public', 'confidential'],
    tenantSlugs: strictViewerScopeTenantSlugs(viewer, narrowing.tenant),
    includeUntenanted: viewer.includeUntenanted === true,
    ...(viewer.principalId ? { viewerPrincipal: viewer.principalId } : {}),
    organizationIds: strictViewerScopeOrganizationIds(viewer, narrowing.organizationId),
    projectIds: strictViewerScopeProjectIds(viewer, narrowing.projectId),
  };
}

/** Scoped meeting-minutes index: mission evidence + notepad records/sessions. */
export async function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  let scope: MinutesScope;
  try {
    scope = minutesScopeFromViewer(resolvedViewer.context, {
      tenant: readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant')),
      organizationId: readChronosOptionalStringParam(
        req.nextUrl.searchParams.get('organization_id')
      ),
      projectId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id')),
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
  const limit = Number(readChronosStringParam(req.nextUrl.searchParams.get('limit')) || 100);
  const query = readChronosStringParam(req.nextUrl.searchParams.get('query')).toLowerCase();
  const source = readChronosStringParam(req.nextUrl.searchParams.get('source'));

  const minutes = withViewerExecutionContext(resolvedViewer.context, () =>
    listMeetingMinutes(scope, Number.isFinite(limit) ? limit : 100)
  ).filter(
    (item) =>
      (!source || item.source === source) &&
      (!query ||
        `${item.title} ${item.missionId ?? ''} ${item.tenantSlug ?? ''} ${item.summary ?? ''}`
          .toLowerCase()
          .includes(query))
  );

  return NextResponse.json({ minutes });
}
