import { NextRequest, NextResponse } from 'next/server';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { buildMissionHistoryItems, collectCostSummary } from '../../../../lib/ops/su-surface-data';
import {
  resolveOpsViewerForRequest,
  strictViewerScopeTenantSlugs,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';
import {
  readChronosOptionalStringParam,
  readChronosStringParam,
} from '../../../../lib/ops/request-input';

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const url = new URL(req.url);
  const budget = Number(
    readChronosStringParam(url.searchParams.get('budgetUsd')) ||
      getRegisteredEnvText('CHRONOS_COST_BUDGET_USD') ||
      ''
  );
  const requestedTenant = readChronosOptionalStringParam(url.searchParams.get('tenant'));
  const summary = withViewerExecutionContext(resolvedViewer.context, () =>
    (() => {
      const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
      const missionIds =
        tenantSlugs === 'all'
          ? undefined
          : buildMissionHistoryItems({ tenantSlugs, limit: 10000 }).map(
              (mission) => mission.missionId
            );
      return collectCostSummary({
        missionId: readChronosOptionalStringParam(url.searchParams.get('missionId')),
        missionIds,
        since: readChronosOptionalStringParam(url.searchParams.get('since')),
        budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        ...(tenantSlugs !== 'all' ? { scopeFilter: { tenant_slugs: tenantSlugs } } : {}),
      });
    })()
  );
  return NextResponse.json({ summary, tenant: requestedTenant || null });
}
