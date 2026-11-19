import { describe, expect, it } from 'vitest';
import {
  attentionCount,
  buildRail,
  deckCounts,
  flattenRail,
  laneForMission,
  phaseForMission,
  reconcileSelection,
} from './attention.js';
import { computeLayout, displayWidth, fitWidth } from './layout.js';
import {
  EMPTY_SNAPSHOT,
  type DeckSnapshot,
  type DecisionItem,
  type DeckMissionRow,
} from './types.js';

function mission(id: string, status: string, updatedAt?: string): DeckMissionRow {
  return {
    id,
    status,
    tier: 'public',
    checkpoints: 0,
    artifactCount: 0,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function decision(id: string, requestedAt: string): DecisionItem {
  return {
    id,
    title: `Decide ${id}`,
    question: '?',
    reasons: [],
    ifNoResponse: 'waits',
    reversible: true,
    level: 'decide',
    requestedAt,
    cardLines: [],
  };
}

function snap(partial: Partial<DeckSnapshot>): DeckSnapshot {
  return { ...EMPTY_SNAPSHOT, ...partial };
}

describe('lane and phase mapping', () => {
  it('maps lifecycle status to lanes', () => {
    expect(laneForMission('active')).toBe('running');
    expect(laneForMission('validating')).toBe('review');
    expect(laneForMission('PAUSED')).toBe('blocked');
    expect(laneForMission('failed')).toBe('blocked');
    expect(laneForMission('completed')).toBe('done');
    expect(laneForMission('distilling')).toBe('done');
  });

  it('maps lifecycle status to the phase strip', () => {
    expect(phaseForMission('planned', false)).toBe('intent');
    expect(phaseForMission('planned', true)).toBe('agreed');
    expect(phaseForMission('active', true)).toBe('executing');
    expect(phaseForMission('validating', true)).toBe('review');
    expect(phaseForMission('distilling', true)).toBe('learning');
    expect(phaseForMission('archived', true)).toBe('done');
    expect(phaseForMission('weird', true)).toBe('intent');
  });
});

describe('buildRail', () => {
  const snapshot = snap({
    decisions: [decision('old', '2026-11-01'), decision('new', '2026-11-19')],
    agents: [
      { target: 'a1', name: 'claude', state: 'blocked', missionId: 'M1', tail: [] },
      { target: 'a2', name: 'codex', state: 'working', missionId: 'M1', tail: [] },
    ],
    missions: [
      mission('M1', 'active', '2026-11-18'),
      mission('M2', 'active', '2026-11-19'),
      mission('M3', 'validating'),
      ...Array.from({ length: 7 }, (_, i) => mission(`D${i}`, 'completed', `2026-10-0${i + 1}`)),
    ],
  });

  it('orders lanes by attention and puts human waits first', () => {
    const groups = buildRail(snapshot);
    expect(groups.map((g) => g.lane)).toEqual(['decide', 'review', 'running', 'done']);
    expect(groups[0]!.items.map((i) => i.key)).toEqual([
      'decision:new',
      'decision:old',
      'agent:a1',
    ]);
  });

  it('sorts missions newest first, links agents, and caps the done lane', () => {
    const groups = buildRail(snapshot, { doneLimit: 3 });
    const running = groups.find((g) => g.lane === 'running')!;
    expect(running.items.map((i) => i.key)).toEqual(['mission:M2', 'mission:M1']);
    const m1 = running.items[1]!;
    expect(m1.kind === 'mission' && m1.agents.map((a) => a.target)).toEqual(['a1', 'a2']);
    expect(groups.find((g) => g.lane === 'done')!.items).toHaveLength(3);
    expect(flattenRail(groups)).toHaveLength(3 + 1 + 2 + 3);
  });

  it('counts attention and lanes', () => {
    expect(attentionCount(snapshot)).toBe(3);
    expect(deckCounts(snapshot)).toEqual({ decide: 3, running: 2, review: 1, done: 7 });
  });

  it('returns no groups for an empty snapshot', () => {
    expect(buildRail(EMPTY_SNAPSHOT)).toEqual([]);
  });
});

describe('reconcileSelection', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  it('keeps the selected key when it still exists', () => {
    expect(reconcileSelection(items, 'c', 0)).toEqual({ key: 'c', index: 2 });
  });
  it('stays at the clamped index when the key disappeared', () => {
    expect(reconcileSelection(items, 'gone', 1)).toEqual({ key: 'b', index: 1 });
    expect(reconcileSelection(items, 'gone', 9)).toEqual({ key: 'c', index: 2 });
  });
  it('handles an empty list', () => {
    expect(reconcileSelection([], 'a', 3)).toEqual({ key: undefined, index: 0 });
  });
});

describe('computeLayout', () => {
  it('uses three columns on wide terminals in the conversation view', () => {
    const layout = computeLayout(160, 40, 'conversation', 2);
    expect(layout.compact).toBe(false);
    expect(layout.railWidth).toBeGreaterThan(0);
    expect(layout.agentsWidth).toBeGreaterThan(0);
    expect(layout.railWidth + layout.mainWidth + layout.agentsWidth).toBe(160);
  });

  it('drops side columns below the breakpoint', () => {
    const layout = computeLayout(80, 24, 'conversation', 2);
    expect(layout.compact).toBe(true);
    expect(layout.railWidth).toBe(0);
    expect(layout.agentsWidth).toBe(0);
    expect(layout.grid.cols).toBe(1);
  });

  it('gives the terminals view the full width as a grid', () => {
    const layout = computeLayout(200, 50, 'terminals', 6);
    expect(layout.railWidth).toBe(0);
    expect(layout.grid.cols).toBe(3);
    expect(layout.grid.tileWidth * layout.grid.cols).toBeLessThanOrEqual(layout.mainWidth);
  });

  it('clamps nonsense sizes', () => {
    const layout = computeLayout(0, 0, 'missions', 0);
    expect(layout.columns).toBe(80);
    expect(layout.rows).toBe(24);
  });
});

describe('fitWidth', () => {
  it('counts wide characters as two cells', () => {
    expect(displayWidth('承認')).toBe(4);
    expect(fitWidth('承認しますか', 5)).toBe('承認…');
    expect(displayWidth(fitWidth('承認しますか', 5))).toBeLessThanOrEqual(5);
  });
  it('leaves short text untouched and handles zero width', () => {
    expect(fitWidth('ok', 10)).toBe('ok');
    expect(fitWidth('ok', 0)).toBe('');
  });
});
