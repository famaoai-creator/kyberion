import { describe, expect, it } from 'vitest';
import { buildMissionChangesTasksSummary } from './mission-changes-tasks-summary.js';

describe('buildMissionChangesTasksSummary', () => {
  it('caps paths and projects child WorkItems', () => {
    const summary = buildMissionChangesTasksSummary({
      missionId: 'm-1',
      artifacts: [
        { path: 'evidence/a.md', kind: 'evidence', updated_at: '2026-11-22T00:00:00.000Z' },
      ],
      diff: {
        files_changed: 2,
        insertions: 10,
        deletions: 1,
        paths: ['a.ts', 'b.ts', 'c.ts'],
      },
      children: [
        { item_id: 'wi-1', title: 'Fix', status: 'blocked', parent_item_id: 'issue-1' },
        {
          item_id: 'wi-2',
          title: 'Other mission',
          status: 'ready',
          context: { mission_id: 'm-other' },
        },
      ],
      pathCap: 2,
    });

    expect(summary.mission_id).toBe('m-1');
    expect(summary.this_turn_artifacts).toHaveLength(1);
    expect(summary.uncommitted_diff.paths).toEqual(['a.ts', 'b.ts']);
    expect(summary.child_work_items.map((c) => c.item_id)).toEqual(['wi-1']);
  });
});
