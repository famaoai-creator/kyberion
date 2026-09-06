import { NextRequest, NextResponse } from 'next/server';

import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { collectDeliverableInbox } from '../../../lib/deliverable-inbox';
import {
  resolveViewerContextForRequest,
  strictViewerTier,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { readChronosOptionalStringParam, readChronosStringParam } from '../../../lib/request-input';

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  let tenantSlugs: string[] | 'all';
  let organizationIds: string[] | 'all';
  let projectIds: string[] | 'all';
  let tier: 'personal' | 'confidential' | 'public' | '';
  try {
    tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'))
    );
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
      organizationIds,
      projectIds,
    })
  );

  return NextResponse.json({ deliverables, accessRole: resolvedViewer.context.role });
}
