import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { collectOperatorHomeSummary } from '@agent/core/operator-home-summary';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { readChronosOptionalStringParam, readChronosStringParam } from '../../../lib/request-input';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const url = new URL(req.url);
  const budgetUsd = Number(readChronosStringParam(url.searchParams.get('budgetUsd')) || '');
  const limit = Number(readChronosStringParam(url.searchParams.get('limit')) || 8);
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

    const summary = withViewerExecutionContext(resolvedViewer.context, () =>
      collectOperatorHomeSummary({
        budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : undefined,
        since: readChronosOptionalStringParam(url.searchParams.get('since')),
        limit: Number.isFinite(limit) && limit > 0 ? limit : 8,
        scope: { tenantSlugs, organizationIds, projectIds },
      })
    );
    return NextResponse.json({ summary });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
