import { describe, expect, it } from 'vitest';
import { groupMissionBoard, missionBoardColumn } from './mission-state-board';

describe('mission state board', () => {
  it.each([
    ['active', 'in_progress'],
    ['planned', 'planned'],
    ['paused', 'waiting'],
    ['failed', 'waiting'],
    ['validating', 'review'],
    ['distilling', 'review'],
    ['completed', 'done'],
    ['archived', 'done'],
    ['something-new', 'waiting'],
    [undefined, 'waiting'],
  ])('puts %s in %s', (status, column) => {
    expect(missionBoardColumn(status)).toBe(column);
  });

  it('keeps the five columns in order, counts everything and caps cards newest first', () => {
    const columns = groupMissionBoard(
      [
        { id: 'a', label: 'A', status: 'active', updatedAt: '2026-11-01T00:00:00Z' },
        { id: 'b', label: 'B', status: 'active', updatedAt: '2026-11-03T00:00:00Z' },
        { id: 'c', label: 'C', status: 'active' },
        { id: 'd', label: 'D', status: 'completed' },
        { id: 'e', label: 'E', status: 'planned' },
      ],
      2
    );
    expect(columns.map((column) => column.id)).toEqual([
      'planned',
      'in_progress',
      'waiting',
      'review',
      'done',
    ]);
    expect(columns[1].count).toBe(3);
    expect(columns[1].missions.map((m) => m.id)).toEqual(['b', 'a']);
    expect(columns[2]).toEqual({ id: 'waiting', count: 0, missions: [] });
    expect(columns[4].count).toBe(1);
    expect(columns[0]).toMatchObject({ id: 'planned', count: 1 });
  });
});
