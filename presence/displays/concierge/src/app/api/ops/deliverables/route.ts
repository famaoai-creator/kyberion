import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { collectDeliverableInbox } from '../../../../lib/ops/deliverable-inbox';
import { viewerPersonIds } from '@agent/core/surface/surface-authorization';
import {
  resolveOpsViewerForRequest,
  strictViewerTier,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';
import {
  readChronosOptionalStringParam,
  readChronosStringParam,
} from '../../../../lib/ops/request-input';

export async function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  let tenantSlugs: string[] | 'all';
  let requestedTenant: string | undefined;
  let organizationIds: string[] | 'all';
  let projectIds: string[] | 'all';
  let tier: 'personal' | 'confidential' | 'public' | '';
  try {
    requestedTenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
    tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
    organizationIds = strictViewerScopeOrganizationIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization_id'))
    );
    projectIds = strictViewerScopeProjectIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id'))
    );
    const requestedTier = readChronosStringParam(req.nextUrl.searchParams.get('tier'));
    tier = requestedTier
      ? strictViewerTier(
          resolvedViewer.context,
          requestedTier as 'personal' | 'confidential' | 'public'
        )
      : '';
  } catch (error) {
    return viewerErrorResponse(error);
  }
  const limit = Number(readChronosStringParam(req.nextUrl.searchParams.get('limit')) || 50);
  const deliverables = withViewerExecutionContext(resolvedViewer.context, () =>
    collectDeliverableInbox({
      query: readChronosStringParam(req.nextUrl.searchParams.get('query')),
      missionId: readChronosStringParam(req.nextUrl.searchParams.get('missionId')),
      kind: readChronosStringParam(req.nextUrl.searchParams.get('kind')),
      tier,
      tierAccess: resolvedViewer.context.tierAccess ?? ['public', 'confidential'],
      limit: Number.isFinite(limit) ? limit : 50,
      tenantSlugs,
      requestedTenant,
      includeUntenanted: resolvedViewer.context.includeUntenanted === true,
      personIds: viewerPersonIds(resolvedViewer.context),
      organizationIds,
      projectIds,
    })
  );

  return NextResponse.json({ deliverables, accessRole: resolvedViewer.context.role });
}
