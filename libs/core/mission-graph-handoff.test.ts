import { describe, expect, it } from 'vitest';
import { buildMissionGraphInputs, collectMissionGraphHandoffs } from './mission-graph-handoff.js';

describe('mission graph handoff contract', () => {
  it('compiles task dependencies into explicit data channels', () => {
    expect(
      buildMissionGraphInputs([
        { task_id: 'implement' },
        { task_id: 'review', dependencies: ['implement', 'implement'] },
      ])
    ).toEqual([
      {
        id: 'implement',
        depends_on: [],
        produces: 'mission-task:implement',
        consumes: [],
        merge: 'namespace',
      },
      {
        id: 'review',
        depends_on: ['implement'],
        produces: 'mission-task:review',
        consumes: ['mission-task:implement'],
        merge: 'namespace',
      },
    ]);
  });

  it('only exposes direct predecessor handoffs to a successor', () => {
    const handoff = { from_task_id: 'implement', status: 'completed' };
    expect(
      collectMissionGraphHandoffs(
        {
          implement: { handoff },
          unrelated: { handoff: { from_task_id: 'unrelated', status: 'completed' } },
        },
        ['implement']
      )
    ).toEqual([handoff]);
  });
});
