import { NextRequest, NextResponse } from 'next/server';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { buildMissionHistoryItems, collectCostSummary } from '../../../lib/su-surface-data';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
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
  const budget = Number(
    url.searchParams.get('budgetUsd') || getRegisteredEnvText('CHRONOS_COST_BUDGET_USD') || ''
  );
  const requestedTenant = url.searchParams.get('tenant') || undefined;
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
        missionId: url.searchParams.get('missionId') || undefined,
        missionIds,
        since: url.searchParams.get('since') || undefined,
        budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        ...(tenantSlugs !== 'all' ? { scopeFilter: { tenant_slugs: tenantSlugs } } : {}),
      });
    })()
  );
  return NextResponse.json({ summary, tenant: requestedTenant || null });
}
