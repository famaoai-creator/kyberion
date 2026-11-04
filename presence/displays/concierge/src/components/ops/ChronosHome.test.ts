import { describe, expect, it } from 'vitest';

import {
  CHRONOS_ACTIONS,
  CHRONOS_NAV_GROUPS,
  CONSOLE_SECTIONS,
  OPS_DEFAULT_SECTION,
  OPS_MOVED_SECTIONS,
  chronosNavGroupFor,
  resolveConsoleSectionParam,
} from '../../app/ops/chronos-page-config';
import { buildChronosNextAction, countRuntimeIssues } from './ChronosHome';
import { buildMissionRows, humanizeMissionId } from './ChronosOffice';
import type { ClientOperatorHomeSummary } from '../../lib/ops/operator-home-response';

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

describe('MSN-SHELL-IA /ops sections (operations only)', () => {
  it('renders only the four operations sections; everything else moved out', () => {
    expect(CHRONOS_NAV_GROUPS.map((group) => group.id)).toEqual(['operate']);
    expect(CHRONOS_NAV_GROUPS[0].sections).toEqual([
      'operations',
      'surface-control',
      'diagnostics',
      'discussion',
    ]);
    for (const id of CHRONOS_NAV_GROUPS[0].sections) {
      expect(CONSOLE_SECTIONS.some((section) => section.id === id)).toBe(true);
      expect(OPS_MOVED_SECTIONS.has(id)).toBe(false);
    }
    expect(OPS_DEFAULT_SECTION).toBe('operations');
  });

  it('resolves only sections /ops still renders', () => {
    expect(resolveConsoleSectionParam('diagnostics')).toBe('diagnostics');
    expect(resolveConsoleSectionParam('surface')).toBe('surface');
    for (const moved of [
      'home',
      'missions',
      'deliverables',
      'approvals',
      'governance',
      'knowledge',
    ]) {
      expect(resolveConsoleSectionParam(moved)).toBeNull();
      expect(OPS_MOVED_SECTIONS.has(moved)).toBe(true);
    }
    expect(resolveConsoleSectionParam('nope')).toBeNull();
    expect(resolveConsoleSectionParam(null)).toBeNull();
    expect(chronosNavGroupFor('diagnostics')).toBe('operate');
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
