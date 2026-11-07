import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import { buildMissionHistoryItems } from '../../../../../lib/ops/su-surface-data';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  withViewerExecutionContext,
} from '../../../../../lib/ops/ops-viewer';
import {
  readChronosOptionalStringParam,
  readChronosStringParam,
} from '../../../../../lib/ops/request-input';

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const url = new URL(req.url);
  try {
    const tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      readChronosOptionalStringParam(url.searchParams.get('tenant'))
    );
    const organizationIds = strictViewerScopeOrganizationIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(url.searchParams.get('organization_id'))
    );
    const projectIds = strictViewerScopeProjectIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(url.searchParams.get('project_id'))
    );
    const missions = withViewerExecutionContext(resolvedViewer.context, () =>
      buildMissionHistoryItems({
        organizationIds,
        projectIds,
        query: readChronosOptionalStringParam(url.searchParams.get('query')),
        status: readChronosOptionalStringParam(url.searchParams.get('status')),
        tier: 'confidential',
        tenant: readChronosOptionalStringParam(url.searchParams.get('tenant')),
        tenantSlugs,
        includeUntenanted: resolvedViewer.context.includeUntenanted,
        kind: readChronosOptionalStringParam(url.searchParams.get('kind')),
        missionId: readChronosOptionalStringParam(url.searchParams.get('missionId')),
        limit: Number(readChronosStringParam(url.searchParams.get('limit')) || 24),
      })
    );
    return NextResponse.json({ missions });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
