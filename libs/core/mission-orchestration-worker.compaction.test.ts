import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDispatchCarryover,
  maybeCompactDispatchSections,
} from './mission-orchestration-worker.js';
import { resetReasoningBackend } from './reasoning-backend.js';

const MISSION_ID = 'OH1-DISPATCH-FIXTURE';

function makeTasks() {
  const allTasks = [
    {
      task_id: 'T1',
      status: 'completed',
      deliverable: 'active/missions/confidential/OH1/report-draft.md',
      description: 'Draft the report',
    },
    {
      task_id: 'T2',
      status: 'accepted',
      target_path: 'active/missions/confidential/OH1/figures/',
      description: 'Prepare figures',
    },
    {
      task_id: 'T3',
      status: 'planned',
      description: 'Assemble final deliverable',
      dependencies: ['T1', 'T2'],
    },
  ];
  return { task: allTasks[2], allTasks };
}

describe('mission-orchestration-worker dispatch compaction (OH-01)', () => {
  afterEach(() => {
    delete process.env.KYBERION_CONTEXT_WINDOW_TOKENS;
    delete process.env.KYBERION_CONTEXT_RESERVE_TOKENS;
    delete process.env.KYBERION_CONTEXT_BUFFER_TOKENS;
    resetReasoningBackend();
  });

  it('builds carryover from mission goal and settled tasks', () => {
    const { task, allTasks } = makeTasks();
    const carryover = buildDispatchCarryover({
      task,
      allTasks,
      missionGoalLines: ['Deliver the Q3 governance evidence pack'],
    });
    expect(carryover.goal).toBe('Deliver the Q3 governance evidence pack');
    expect(carryover.active_artifacts).toEqual([
      'active/missions/confidential/OH1/report-draft.md',
      'active/missions/confidential/OH1/figures/',
    ]);
    expect(carryover.verified_state).toEqual(['T1: completed', 'T2: accepted']);
    expect(carryover.next_step).toContain('T3');
  });

  it('passes sections through untouched when under the token threshold', async () => {
    const { task, allTasks } = makeTasks();
    const upstreamResultLines = ['- T1 [writer]: done', '- T2 [designer]: done'];
    const teamSnapshotLines = ['- T1 ✅ completed'];
    const result = await maybeCompactDispatchSections({
      missionId: MISSION_ID,
      task,
      allTasks,
      agentId: 'agent-1',
      missionContextPackText: 'pack',
      missionGoalLines: ['goal'],
      upstreamResultLines,
      teamSnapshotLines,
    });
    expect(result.upstreamResultLines).toEqual(upstreamResultLines);
    expect(result.teamSnapshotLines).toEqual(teamSnapshotLines);
  });

  it('compacts oversized dispatch sections and injects the structured carryover', async () => {
    process.env.KYBERION_CONTEXT_WINDOW_TOKENS = '2000';
    process.env.KYBERION_CONTEXT_RESERVE_TOKENS = '500';
    process.env.KYBERION_CONTEXT_BUFFER_TOKENS = '500';
    const { task, allTasks } = makeTasks();
    const bulky = 'r'.repeat(1_000);
    const result = await maybeCompactDispatchSections({
      missionId: MISSION_ID,
      task,
      allTasks,
      agentId: 'agent-1',
      missionContextPackText: 'mission context pack',
      missionGoalLines: ['Deliver the Q3 governance evidence pack'],
      upstreamResultLines: Array.from({ length: 10 }, (_, i) => `- T${i}: ${bulky}`),
      teamSnapshotLines: ['- T1 ✅ completed'],
    });
    // Older upstream bodies elided, and the carryover block survives as
    // structured data in the rebuilt prompt sections (acceptance criterion 1).
    const joined = result.upstreamResultLines.join('\n');
    expect(joined).toContain('elided');
    expect(joined).toContain('<task_focus_state>');
    expect(joined).toContain('goal: Deliver the Q3 governance evidence pack');
    expect(joined).toContain('next_step: T3');
  });
});
