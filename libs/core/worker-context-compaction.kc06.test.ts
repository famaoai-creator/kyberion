import { describe, expect, it } from 'vitest';
import {
  MAX_CARRYOVER_BACKGROUND_TASKS,
  compactWorkerContext,
  loadCarryover,
  persistCarryover,
  renderCarryoverBlock,
  type ActiveBackgroundTaskRef,
  type CompactionCarryover,
  type WorkerContextMessage,
} from './worker-context-compaction.js';
import { MissionWorkingMemory } from './mission-working-memory.js';

function makeBackgroundTasks(count: number): ActiveBackgroundTaskRef[] {
  return Array.from({ length: count }, (_, i) => ({
    delegation_id: `DLG-${i + 1}`,
    instruction_excerpt: `Background task ${i + 1}`,
    started_at: `2026-07-20T0${i % 10}:00:00.000Z`,
  }));
}

describe('KC-06 post-compaction active-task snapshot (carryover)', () => {
  it('renders active background tasks inside the carryover block, bounded to 8', () => {
    const carryover: CompactionCarryover = {
      goal: 'ship the report',
      active_artifacts: [],
      verified_state: [],
      next_step: 'T9: assemble',
      active_background_tasks: makeBackgroundTasks(10),
    };
    const block = renderCarryoverBlock(carryover);
    expect(block).toContain('active_background_tasks:');
    expect(block).toContain('DLG-1 (started');
    expect(block).toContain(`DLG-${MAX_CARRYOVER_BACKGROUND_TASKS}`);
    expect(block).not.toContain('DLG-9');
    expect(block).not.toContain('DLG-10');
  });

  it('omits the section when there are no active background tasks', () => {
    const block = renderCarryoverBlock({
      goal: 'g',
      active_artifacts: [],
      verified_state: [],
      next_step: 'n',
    });
    expect(block).not.toContain('active_background_tasks');
  });

  it('re-injects active background tasks across a forced compaction boundary', async () => {
    const messages: WorkerContextMessage[] = [
      { role: 'system', content: 'pinned framing', pinned: true },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: 'tool_result' as const,
        content: `tool output ${i} ${'x'.repeat(400)}`,
      })),
    ];
    const result = await compactWorkerContext(messages, {
      force: true,
      carryover: {
        goal: 'long-running mission',
        active_artifacts: [],
        verified_state: [],
        next_step: 'continue',
        active_background_tasks: makeBackgroundTasks(2),
      },
    });
    expect(result.compacted).toBe(true);
    const rendered = result.messages.map((message) => message.content).join('\n');
    // A worker resuming after compaction can still reference the running
    // delegations (acceptance criterion 3, data level).
    expect(rendered).toContain('active_background_tasks:');
    expect(rendered).toContain('DLG-1');
    expect(rendered).toContain('DLG-2');
  });

  it('round-trips active background tasks through persisted carryover', () => {
    const workingMemory = new MissionWorkingMemory();
    const missionId = `KC06-CARRYOVER-${process.pid}`;
    const carryover: CompactionCarryover = {
      goal: 'g',
      active_artifacts: [],
      verified_state: [],
      next_step: 'n',
      active_background_tasks: makeBackgroundTasks(1),
    };
    persistCarryover({ workingMemory, missionId, carryover });
    const loaded = loadCarryover(workingMemory, missionId);
    expect(loaded?.active_background_tasks?.[0]?.delegation_id).toBe('DLG-1');
  });
});
