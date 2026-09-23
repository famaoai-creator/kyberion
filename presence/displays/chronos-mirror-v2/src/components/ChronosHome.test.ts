import { describe, expect, it } from 'vitest';

import {
  CHRONOS_ACTIONS,
  CHRONOS_NAV_GROUPS,
  CONSOLE_SECTIONS,
  chronosNavGroupFor,
  resolveConsoleSectionParam,
} from '../app/chronos-page-config';
import { buildChronosNextAction, countRuntimeIssues } from './ChronosHome';
import { buildMissionRows, humanizeMissionId } from './ChronosOffice';
import type { ClientOperatorHomeSummary } from '../lib/operator-home-response';

function summary(counts: Partial<ClientOperatorHomeSummary['counts']>): ClientOperatorHomeSummary {
  return {
    counts: {
      activeMissions: 0,
      recentlyActiveMissions: 0,
      blockedMissions: 0,
      pendingApprovals: 0,
      clarificationQuestions: 0,
      unreadInbox: 0,
      totalInbox: 0,
      pendingQualityDecisions: 0,
      ...counts,
    },
  } as ClientOperatorHomeSummary;
}

const t = (key: string) => key;
const message = (key: string, params: Record<string, number>) => `${key}:${params.count}`;

describe('UI-07 chronos navigation groups', () => {
  it('puts every console section in exactly one of five groups', () => {
    expect(CHRONOS_NAV_GROUPS.map((group) => group.id)).toEqual([
      'home',
      'work',
      'decide',
      'operate',
      'organization',
    ]);
    const grouped = CHRONOS_NAV_GROUPS.flatMap((group) => group.sections);
    const sections = CONSOLE_SECTIONS.map((section) => section.id).filter(
      (id) => id !== 'governance'
    );
    expect([...grouped].sort()).toEqual([...sections].sort());
  });

  it('keeps old ?section= deep links resolving', () => {
    expect(resolveConsoleSectionParam('deliverables')).toBe('deliverables');
    expect(resolveConsoleSectionParam('governance')).toBe('approvals');
    expect(resolveConsoleSectionParam('surface')).toBe('surface');
    expect(resolveConsoleSectionParam('nope')).toBeNull();
    expect(resolveConsoleSectionParam(null)).toBeNull();
    expect(chronosNavGroupFor('work-items')).toBe('work');
    expect(chronosNavGroupFor('diagnostics')).toBe('operate');
    expect(chronosNavGroupFor('governance')).toBe('decide');
    expect(chronosNavGroupFor('surface', 'knowledge')).toBe('decide');
  });
});

/** `KbActionRef.action` may also be a bare action id string. */
function actionOf(
  ref: { action?: unknown } | undefined
): { id?: string; payload?: unknown } | undefined {
  const action = ref?.action;
  return action && typeof action === 'object'
    ? (action as { id?: string; payload?: unknown })
    : undefined;
}

describe('UI-07 home next action', () => {
  it('prioritises blocked missions, then approvals, then runtime issues', () => {
    const blocked = buildChronosNextAction({
      summary: summary({ blockedMissions: 2, pendingApprovals: 1 }),
      runtimeIssues: 3,
      t,
      message,
    });
    expect(blocked.title).toBe('chronos_home_action_blocked');
    expect(actionOf(blocked.primary)?.id).toBe(CHRONOS_ACTIONS.openScenario);

    const approvals = buildChronosNextAction({
      summary: summary({ pendingApprovals: 1 }),
      runtimeIssues: 3,
      t,
      message,
    });
    expect(approvals.reason).toBe('chronos_home_reason_approvals:1');
    expect(actionOf(approvals.primary)?.payload).toEqual({ section: 'approvals' });

    const runtime = buildChronosNextAction({ summary: summary({}), runtimeIssues: 3, t, message });
    expect(runtime.title).toBe('chronos_home_action_runtime');
    expect(actionOf(runtime.primary)?.payload).toEqual({ section: 'operations' });
  });

  it('falls back to a calm empty state', () => {
    const calm = buildChronosNextAction({ summary: summary({}), runtimeIssues: 0, t, message });
    expect(calm.state).toBe('empty');
    expect(calm.primary).toBeUndefined();
  });

  it('counts each blocked/offline/pressured agent once', () => {
    expect(
      countRuntimeIssues([
        {
          room_id: 'MSN-A',
          title: 'MSN-A',
          agents: [
            { agent_id: 'a', status: 'blocked' },
            { agent_id: 'b', status: 'ready', pressure: { severity: 'elevated', value: 1 } },
          ],
        },
        { room_id: 'MSN-B', title: 'MSN-B', agents: [{ agent_id: 'a', status: 'blocked' }] },
      ])
    ).toBe(2);
  });
});

describe('UI-07 mission rows', () => {
  it('uses human titles and sorts by attention', () => {
    const rows = buildMissionRows(
      [
        {
          room_id: 'MSN-QUIET-WORK-20260901',
          title: '',
          agents: [{ agent_id: 'x', status: 'ready' }],
        },
        {
          room_id: 'MSN-HOT-20260902A',
          title: '',
          agents: [
            { agent_id: 'y', status: 'blocked' },
            { agent_id: 'z', status: 'review' },
          ],
        },
      ],
      { 'MSN-HOT-20260902A': 'Ship the proposal deck' }
    );
    expect(rows.map((row) => [row.title, row.status, row.attention])).toEqual([
      ['Ship the proposal deck', 'blocked', 2],
      ['Quiet work', 'ready', 0],
    ]);
    expect(humanizeMissionId('MSN-BACKEND-CAPABILITY-CONSOLIDATION-20260822A')).toBe(
      'Backend capability consolidation'
    );
  });
});
