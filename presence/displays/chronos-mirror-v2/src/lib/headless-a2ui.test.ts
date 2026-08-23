import { describe, expect, it } from 'vitest';
import { buildOperatorHomeA2UI } from './headless-a2ui';
import type { OperatorHomeSummary } from '@agent/core/operator-home-summary';

describe('headless operator-home A2UI adapter', () => {
  it('projects the same semantic summary into a standard updateComponents message', () => {
    const summary = {
      status: 'attention',
      statusLabel: 'Needs attention',
      statusDetail: 'One approval is waiting.',
      counts: {
        activeMissions: 2,
        recentlyActiveMissions: 1,
        blockedMissions: 1,
        pendingApprovals: 1,
        clarificationQuestions: 0,
        unreadInbox: 3,
        totalInbox: 4,
        pendingQualityDecisions: 0,
      },
      activeMissions: [
        {
          missionId: 'MSN-A',
          status: 'active',
          tier: 'public',
          artifactKinds: [],
          artifactCount: 0,
        },
      ],
      actionQueue: [
        {
          actionId: 'approval:1',
          kind: 'approval',
          title: 'Approve release',
          status: 'pending',
          priority: 90,
          nextAction: 'Review and decide',
        },
      ],
      nextAction: {
        title: 'Review approval',
        reason: 'A human decision is pending.',
        next_action_type: 'open_docs',
      },
    } as unknown as OperatorHomeSummary;

    const message = buildOperatorHomeA2UI(summary);
    const components = message.updateComponents?.components || [];

    expect(message.updateComponents?.surfaceId).toBe('chronos.headless.operator-home');
    expect(components.map((component) => component.type)).toEqual([
      'display:hero',
      'display:metrics-row',
      'display:status',
      'display:table',
      'display:list',
    ]);
    expect(components[1]?.props.metrics).toEqual([
      { label: 'Active missions', value: 2 },
      { label: 'Blocked missions', value: 1 },
      { label: 'Pending approvals', value: 1 },
      { label: 'Unread inbox', value: 3 },
    ]);
  });
});
