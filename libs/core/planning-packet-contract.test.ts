import { describe, expect, it } from 'vitest';

import { extractPlanningPacketBlocks, validatePlanningPacket } from './planning-packet-contract.js';

describe('planning-packet-contract', () => {
  it('validates a planning packet against the schema', () => {
    const validation = validatePlanningPacket({
      mission_id: 'MSN-1',
      summary: 'Plan the mission',
      plan_markdown: '# PLAN\n',
      next_tasks: [
        {
          task_id: 'task-1',
          team_role: 'planner',
          description: 'Draft the plan',
          dependencies: [],
          acceptance_criteria: ['PLAN.md is written'],
          risk: 'low',
          expected_output_format: 'files',
          estimated_scope: 'S',
        },
      ],
    });

    expect(validation.valid).toBe(true);
    expect(validation.value?.next_tasks[0]?.team_role).toBe('planner');
    expect(validation.value?.next_tasks[0]?.expected_output_format).toBe('files');
  });

  it('rejects invalid planning packets and reports parse errors', () => {
    const extraction = extractPlanningPacketBlocks(
      ['```planning_packet', '{"plan_markdown":"","next_tasks":[]}', '```'].join('\n')
    );

    expect(extraction.planningPackets).toHaveLength(0);
    expect(extraction.planningPacketErrors[0]).toContain('validation failed');
  });
});
