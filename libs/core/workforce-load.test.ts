import { describe, expect, it } from 'vitest';
import {
  buildAvailabilityRecord,
  buildCostProfileRecord,
  loadWorkforceCapacityPolicy,
  resolveWorkforceLoad,
  type WorkforceLoadIndex,
} from './workforce-load.js';
import { workerLoadPenalty } from './worker-assignment-policy.js';
import { selectAgentForTeamRole } from './team-role-assignment-selection.js';

const ROLE = {
  description: 'Implementer role',
  required_capabilities: ['implementation'],
  compatible_authority_roles: ['mission_controller'],
  allowed_delegate_team_roles: [],
  escalation_parent_team_role: null,
  required_scope_classes: ['mission_state'],
  ownership_scope: 'Implements the change.',
  autonomy_level: 'medium' as const,
};

const AUTHORITY = {
  mission_controller: {
    description: 'Mission controller',
    write_scopes: ['mission_state.write'],
    scope_classes: ['mission_state'],
    allowed_actuators: [],
    tier_access: ['public'],
  },
};

const AGENTS = {
  'agent-busy': {
    authority_roles: ['mission_controller'],
    team_roles: ['implementer'],
    capabilities: ['implementation'],
    selection_hints: { preferred_provider: 'gemini', preferred_modelId: 'auto-gemini-3' },
    provider_strategy: 'strict' as const,
  },
  'agent-free': {
    authority_roles: ['mission_controller'],
    team_roles: ['implementer'],
    capabilities: ['implementation'],
    selection_hints: { preferred_provider: 'gemini', preferred_modelId: 'auto-gemini-3' },
    provider_strategy: 'strict' as const,
  },
};

function loadIndexWith(resourceId: string, activeWorkItems: number): WorkforceLoadIndex {
  return new Map([
    [
      resourceId,
      {
        resource_id: resourceId,
        status: 'busy' as const,
        active_work_items: activeWorkItems,
        queued_work_items: 0,
        active_leases: activeWorkItems,
        leased_scopes: ['MSN-OTHER'],
        observed_at: '2026-09-20T00:00:00.000Z',
      },
    ],
  ]);
}

describe('workforce load (TC-08)', () => {
  it('reports an unknown resource as available rather than failing', () => {
    const snapshot = resolveWorkforceLoad('nobody', new Map());
    expect(snapshot.status).toBe('available');
    expect(snapshot.active_work_items).toBe(0);
  });

  it('persists observed load instead of a constant availability record', () => {
    const availability = buildAvailabilityRecord('agent-busy', loadIndexWith('agent-busy', 2));
    expect(availability).toMatchObject({
      status: 'busy',
      active_work_items: 2,
      active_leases: 2,
      leased_scopes: ['MSN-OTHER'],
    });
  });

  it('prices a resource from the governed model cost registry', () => {
    const profile = buildCostProfileRecord({ provider: 'claude', modelId: 'claude-opus-5' });
    expect(profile).toMatchObject({
      provider: 'claude',
      model_id: 'claude-opus-5',
      unit: 'per_token',
    });
    // Registry stores per-1k rates; the record carries per-token rates.
    expect(profile.prompt).toBeCloseTo(0.005 / 1000, 10);
    expect(profile.completion).toBeCloseTo(0.025 / 1000, 10);
  });

  it('carries no cost profile when the actor has no model', () => {
    expect(buildCostProfileRecord({ provider: 'claude', modelId: null })).toEqual({});
  });
});

describe('load-aware selection (TC-09)', () => {
  it('caps the load penalty so it cannot outweigh a capability match', () => {
    const policy = loadWorkforceCapacityPolicy();
    const penalty = workerLoadPenalty({
      active_work_items: 99,
      queued_work_items: 99,
      status: 'saturated',
    });
    expect(penalty).toBe(policy.selection.max_load_penalty);
  });

  it('scores an idle actor above an equally qualified busy one', () => {
    const base = {
      teamRole: 'implementer',
      teamRoleRecord: ROLE,
      authorityRoles: AUTHORITY,
      agents: AGENTS,
    };
    // Without load information the tie breaks alphabetically.
    expect(selectAgentForTeamRole(base).agent_id).toBe('agent-busy');
    // With it, the busy actor loses.
    expect(
      selectAgentForTeamRole({ ...base, loadIndex: loadIndexWith('agent-busy', 2) }).agent_id
    ).toBe('agent-free');
  });
});
