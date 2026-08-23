import type { A2UIMessage } from '@agent/core/a2ui';
import type { OperatorHomeSummary } from '@agent/core/operator-home-summary';

function statusForA2UI(status: OperatorHomeSummary['status']): string {
  if (status === 'ready') return 'ok';
  if (status === 'blocked') return 'error';
  return 'warning';
}

export function buildOperatorHomeA2UI(summary: OperatorHomeSummary): A2UIMessage {
  const missions = summary.activeMissions.slice(0, 8);
  const actions = (summary.actionQueue || []).slice(0, 8);
  return {
    updateComponents: {
      surfaceId: 'chronos.headless.operator-home',
      components: [
        {
          id: 'operator-home-status',
          type: 'display:hero',
          props: {
            eyebrow: 'Headless operator projection',
            title: summary.statusLabel,
            description: summary.statusDetail,
            status: summary.status,
          },
        },
        {
          id: 'operator-home-counts',
          type: 'display:metrics-row',
          props: {
            metrics: [
              { label: 'Active missions', value: summary.counts.activeMissions },
              { label: 'Blocked missions', value: summary.counts.blockedMissions },
              { label: 'Pending approvals', value: summary.counts.pendingApprovals },
              { label: 'Unread inbox', value: summary.counts.unreadInbox },
            ],
          },
        },
        {
          id: 'operator-home-state',
          type: 'display:status',
          props: {
            label: 'Next action',
            status: statusForA2UI(summary.status),
            detail: summary.nextAction?.title || summary.nextAction?.reason || 'No action queued',
          },
        },
        {
          id: 'operator-home-missions',
          type: 'display:table',
          props: {
            title: 'Active missions',
            headers: ['Mission', 'Status', 'Tier', 'Tenant'],
            rows: missions.map((mission) => [
              mission.missionId,
              mission.status,
              mission.tier,
              mission.tenantSlug || 'shared',
            ]),
          },
        },
        {
          id: 'operator-home-actions',
          type: 'display:list',
          props: {
            title: 'Attention queue',
            items: actions.map((action) => ({
              label: action.title,
              detail: `${action.kind} · ${action.nextAction}`,
            })),
          },
        },
      ],
    },
  };
}
