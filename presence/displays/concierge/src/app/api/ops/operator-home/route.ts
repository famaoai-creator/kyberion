import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { collectOperatorHomeSummary } from '@agent/core/surface/operator-home-summary';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';
import {
  readChronosOptionalStringParam,
  readChronosStringParam,
} from '../../../../lib/ops/request-input';
import { viewerPersonIds } from '@agent/core/surface/surface-authorization';

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
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
        scope: {
          tenantSlugs,
          organizationIds,
          projectIds,
          // The viewer's own person ids admit person-custody rows to their
          // owner — same wiring as the headless projection.
          personIds: viewerPersonIds(resolvedViewer.context),
          ...(resolvedViewer.context.includeUntenanted ? { includeUntenanted: true } : {}),
        },
      })
    );
    return NextResponse.json({ summary });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
