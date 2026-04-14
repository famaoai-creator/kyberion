import { describe, expect, it } from 'vitest';
import { recommendWorkerAssignments } from './worker-assignment-policy.js';

describe('worker-assignment-policy', () => {
  it('prefers workers that match required capabilities and role', () => {
    const [decision] = recommendWorkerAssignments({
      tasks: [{
        task_id: 'TASK-1',
        title: 'Review PR 128',
        required_capabilities: ['review', 'code_read'],
        preferred_team_role: 'reviewer',
      }],
      workers: [
        {
          agent_id: 'worker-a',
          team_roles: ['reviewer'],
          capabilities: ['review', 'code_read'],
          active_lease_count: 0,
        },
        {
          agent_id: 'worker-b',
          team_roles: ['implementer'],
          capabilities: ['code_write'],
          active_lease_count: 0,
        },
      ],
    });
    expect(decision.agent_id).toBe('worker-a');
    expect(decision.rationale.join(' ')).toContain('matched capabilities');
  });

  it('avoids workers whose leased scope conflicts with the task scope', () => {
    const [decision] = recommendWorkerAssignments({
      tasks: [{
        task_id: 'TASK-2',
        title: 'Fix payments module',
        required_capabilities: ['code_write'],
        scope: 'repo:payments',
      }],
      workers: [
        {
          agent_id: 'worker-a',
          team_roles: ['implementer'],
          capabilities: ['code_write'],
          leased_scopes: ['repo:payments'],
        },
        {
          agent_id: 'worker-b',
          team_roles: ['implementer'],
          capabilities: ['code_write'],
          leased_scopes: ['repo:search'],
        },
      ],
    });
    expect(decision.agent_id).toBe('worker-b');
  });
});
