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

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const url = new URL(req.url);
  const budgetUsd = Number(url.searchParams.get('budgetUsd') || '');
  const limit = Number(url.searchParams.get('limit') || 8);
  try {
    const tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      url.searchParams.get('tenant') || undefined
    );
    const organizationIds = strictViewerScopeOrganizationIds(
      resolvedViewer.context,
      url.searchParams.get('organization_id') || undefined
    );
    const projectIds = strictViewerScopeProjectIds(
      resolvedViewer.context,
      url.searchParams.get('project_id') || undefined
    );

    const summary = withViewerExecutionContext(resolvedViewer.context, () =>
      collectOperatorHomeSummary({
        budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : undefined,
        since: url.searchParams.get('since') || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 8,
        scope: { tenantSlugs, organizationIds, projectIds },
      })
    );
    return NextResponse.json({ summary });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
