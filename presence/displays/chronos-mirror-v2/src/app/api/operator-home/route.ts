import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { collectOperatorHomeSummary } from '@agent/core/operator-home-summary';
import { buildMissionHistoryItems, collectCostSummary } from '../../../lib/su-surface-data';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { resolveApprovalTenant } from '../../../lib/su-surface-data';

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

  const summary = withViewerExecutionContext(resolvedViewer.context, () =>
    collectOperatorHomeSummary({
      budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : undefined,
      since: url.searchParams.get('since') || undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 8,
    })
  );

  const requestedTenant = url.searchParams.get('tenant') || undefined;
  const tenantSlugs = requestedTenant
    ? strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant)
    : resolvedViewer.context.tenantSlugs;
  if (tenantSlugs !== 'all') {
    const scopedMissionHistory = buildMissionHistoryItems({ tenantSlugs, limit: 10000 });
    const scopedBlockedMissions = scopedMissionHistory.filter((mission) =>
      ['paused', 'failed'].includes(String(mission.status).toLowerCase())
    );
    const scopedPlannedMissions = scopedMissionHistory.filter(
      (mission) => String(mission.status).toLowerCase() === 'planned'
    );
    const activeMissions = summary.activeMissions.filter(
      (mission) => mission.tenantSlug && tenantSlugs.includes(mission.tenantSlug)
    );
    const pendingApprovals = summary.pendingApprovals.filter((approval) => {
      const tenant = resolveApprovalTenant(approval);
      return Boolean(tenant && tenantSlugs.includes(tenant));
    });
    const inboxEntries = summary.inboxEntries.filter(
      (entry) => entry.tenant_slug && tenantSlugs.includes(entry.tenant_slug)
    );
    const unreadInbox = inboxEntries.filter((entry) => entry.status === 'unread').length;
    const recentlyActiveMissions = activeMissions.filter((mission) => {
      const updated = Date.parse(String(mission.updatedAt || ''));
      return Number.isFinite(updated) && Date.now() - updated < 7 * 24 * 60 * 60 * 1000;
    }).length;
    const status =
      scopedBlockedMissions.length > 0
        ? 'blocked'
        : scopedPlannedMissions.length > 0 || pendingApprovals.length > 0 || unreadInbox > 0
          ? 'attention'
          : 'ready';
    return NextResponse.json({
      summary: {
        ...summary,
        activeMissions,
        pendingApprovals,
        inboxEntries,
        actionQueue: summary.actionQueue?.filter((action) =>
          Boolean(
            action.missionId &&
            activeMissions.some((mission) => mission.missionId === action.missionId)
          )
        ),
        costSummary: withViewerExecutionContext(resolvedViewer.context, () =>
          collectCostSummary({
            missionIds: buildMissionHistoryItems({ tenantSlugs, limit: 10000 }).map(
              (mission) => mission.missionId
            ),
            since: url.searchParams.get('since') || undefined,
            budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : undefined,
          })
        ),
        workforceSummary: undefined,
        nhiLedger: undefined,
        qualitySummary: undefined,
        status,
        statusLabel:
          status === 'blocked'
            ? 'blocked'
            : status === 'attention'
              ? 'attention required'
              : 'ready',
        statusDetail:
          status === 'blocked'
            ? `${scopedBlockedMissions.length} mission(s) are paused or failed in this tenant.`
            : status === 'attention'
              ? `${scopedPlannedMissions.length} planned mission(s), ${pendingApprovals.length} approval(s), and ${unreadInbox} inbox item(s) need attention.`
              : 'No blocking issues detected for this tenant.',
        plannedMissions: scopedPlannedMissions,
        counts: {
          ...summary.counts,
          activeMissions: activeMissions.length,
          recentlyActiveMissions,
          pendingApprovals: pendingApprovals.length,
          unreadInbox,
          totalInbox: inboxEntries.length,
          blockedMissions: scopedBlockedMissions.length,
        },
      },
    });
  }

  return NextResponse.json({ summary });
}
