import { describe, expect, it } from 'vitest';
import { MissionWorkingMemory } from './mission-working-memory.js';

describe('mission-working-memory', () => {
  it('stores mission-scoped entries and produces a summary', () => {
    const memory = new MissionWorkingMemory();
    memory.write({
      mission_id: 'MSN-1',
      scope: 'task',
      task_id: 'TASK-1',
      key: 'finding',
      value: 'Payment timeout spikes after vendor API retries.',
      writer_agent: 'reviewer-a',
    });
    memory.write({
      mission_id: 'MSN-1',
      scope: 'mission',
      key: 'next_step',
      value: 'Verify retry budget before rollout.',
      writer_agent: 'owner-a',
    });

    expect(memory.list({ missionId: 'MSN-1', scope: 'task' })).toHaveLength(1);
    expect(memory.summarize('MSN-1')).toContain('Payment timeout spikes');
    expect(memory.summarize('MSN-1')).toContain('next_step');
  });
});
