import { describe, expect, it } from 'vitest';
import type { MissionTeamAssignment } from './mission-team-composer.js';
import { inferTaskTargetPath, validateDelegatedTaskPreflight } from './delegation-preflight.js';

function assignmentWithContract(overrides: Partial<MissionTeamAssignment['delegation_contract']> = {}): MissionTeamAssignment {
  return {
    team_role: 'implementer',
    required: true,
    status: 'assigned',
    agent_id: 'implementation-architect',
    authority_role: 'ecosystem_architect',
    delegation_contract: {
      ownership_scope: 'bounded implementation',
      allowed_delegate_team_roles: [],
      escalation_parent_team_role: 'planner',
      required_scope_classes: ['codebase_core'],
      resolved_scope_classes: ['codebase_core'],
      allowed_write_scopes: ['libs/core/', 'scripts/'],
      ...overrides,
    },
    provider: 'gemini',
    modelId: 'auto-gemini-3',
    required_capabilities: ['code'],
    notes: 'test',
  };
}

describe('delegation-preflight', () => {
  it('infers target path from explicit target_path first', () => {
    expect(inferTaskTargetPath({ target_path: 'libs/core/new-file.ts', deliverable: 'docs' })).toBe('libs/core/new-file.ts');
  });

  it('allows paths within assignment scopes and scope class', () => {
    const result = validateDelegatedTaskPreflight({
      task: {
        task_id: 'task-1',
        team_role: 'implementer',
        target_path: 'libs/core/new-file.ts',
      },
      assignment: assignmentWithContract(),
    });

    expect(result.allowed).toBe(true);
    expect(result.target_scope_class).toBe('codebase_core');
  });

  it('blocks paths outside assignment allowed_write_scopes', () => {
    const result = validateDelegatedTaskPreflight({
      task: {
        task_id: 'task-2',
        team_role: 'implementer',
        target_path: 'knowledge/public/architecture/new.md',
      },
      assignment: assignmentWithContract(),
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('outside assignment allowed_write_scopes');
  });
});
