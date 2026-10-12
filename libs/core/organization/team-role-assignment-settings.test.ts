import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), discover: vi.fn() }));
vi.mock('../agent/agent-performance-index.js', () => ({ performanceScoreAdjustment: () => 0 }));
vi.mock('../reasoning/model-performance-index.js', () => ({
  modelPerformanceScoreAdjustment: () => 0,
}));
vi.mock('../reasoning/model-role-fitness.js', () => ({ modelRoleFitnessScoreAdjustment: () => 0 }));
vi.mock('../agent/agent-identity.js', () => ({ deriveAgentNhiId: (id: string) => 'nhi:' + id }));
vi.mock('../agent/agent-provider-resolution.js', () => ({
  resolveAgentProviderTarget: mocks.resolve,
}));
vi.mock('../agent/agent-manifest.js', () => ({
  resolveSelectionHints: (
    h: { preferred_provider?: string; preferred_modelId?: string } | undefined,
    provider: string,
    modelId: string
  ) => ({ provider: h?.preferred_provider || provider, modelId: h?.preferred_modelId || modelId }),
}));
vi.mock('./team-role-selection.js', () => ({
  resolveTeamRoleSelectionHints: () => ({ preferred_agents: ['a'], preferred_models: [] }),
}));
vi.mock('../reasoning/reasoning-model-routing.js', () => ({ resolveModelProvider: () => 'p' }));
vi.mock('../provider/provider-config.js', () => ({
  loadProviderConfig: () => ({ default_priority: ['p'], default_models: { p: 'm' } }),
}));
vi.mock('../workforce/workforce-load.js', () => ({ resolveWorkforceLoad: () => ({}) }));
vi.mock('../workforce/worker-assignment-policy.js', () => ({ workerLoadPenalty: () => 0 }));
import {
  selectAgentForTeamRole,
  normalizeMissionTeamRoleSelection,
  type SelectAgentForTeamRoleInput,
} from './team-role-assignment-selection.js';

const input: SelectAgentForTeamRoleInput = {
  teamRole: 'reviewer',
  tier: 'public',
  teamRoleRecord: {
    description: 'Review',
    required_capabilities: ['review'],
    compatible_authority_roles: ['audit'],
    required_scope_classes: ['code'],
    ownership_scope: 'review',
    allowed_delegate_team_roles: [],
    escalation_parent_team_role: null,
    autonomy_level: 'high',
  },
  authorityRoles: {
    audit: {
      description: 'audit',
      write_scopes: [],
      scope_classes: ['code'],
      allowed_actuators: [],
      tier_access: ['public'],
    },
  },
  agents: {
    a: { authority_roles: ['audit'], team_roles: ['reviewer'], capabilities: ['review'] },
    b: { authority_roles: ['audit'], team_roles: ['reviewer'], capabilities: ['review'] },
  },
};

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.resolve.mockImplementation((options) => ({
    provider: options.fixedProvider || options.preferredProvider,
    modelId: options.fixedModelId || options.preferredModelId,
    strategy: 'preferred',
    availableProviders: ['p'],
  }));
});
describe('explicit mission actor selection', () => {
  it('keeps agent identity independent from provider and exact model constraints', () => {
    const result = selectAgentForTeamRole({
      ...input,
      requestedSelection: { mode: 'fixed', agent_id: 'b', provider: 'p2', model_id: 'exact-v2' },
      discoveredProviders: [],
    });
    expect(result.agent_id).toBe('b');
    expect(result.provider).toBe('p2');
    expect(result.modelId).toBe('exact-v2');
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionMode: 'fixed',
        fixedProvider: 'p2',
        fixedModelId: 'exact-v2',
        requiredCapabilities: ['review'],
      }),
      []
    );
    expect(result.requested_selection?.agent_id).toBe('b');
  });
  it('never replaces an unavailable fixed identity', () => {
    const result = selectAgentForTeamRole({
      ...input,
      requestedSelection: { mode: 'fixed', agent_id: 'missing' },
    });
    expect(result.status).toBe('unfilled');
    expect(result.agent_id).toBeNull();
    expect(result.selection_resolution?.source).toBe('blocked');
  });
  it('fails closed on unavailable fixed provider/model', () => {
    mocks.resolve.mockImplementation(() => {
      throw new Error('fixed target unavailable');
    });
    const result = selectAgentForTeamRole({
      ...input,
      requestedSelection: { mode: 'fixed', model_id: 'unknown' },
    });
    expect(result.status).toBe('unfilled');
    expect(result.selection_resolution?.reason).toContain('unavailable');
  });
  it('enforces every actor capability rather than scoring partial coverage', () => {
    const result = selectAgentForTeamRole({
      ...input,
      agents: { a: { ...input.agents.a!, capabilities: [] } },
      requestedSelection: { mode: 'fixed', agent_id: 'a' },
    });
    expect(result.status).toBe('unfilled');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it.each(['authority', 'scope', 'tier'])('rejects an incompatible %s boundary', (boundary) => {
    const authority = { ...input.authorityRoles.audit! };
    if (boundary === 'scope') authority.scope_classes = [];
    if (boundary === 'tier') authority.tier_access = ['personal'];
    const agents = {
      a: {
        ...input.agents.a!,
        authority_roles: boundary === 'authority' ? ['unrelated'] : ['audit'],
      },
    };
    expect(
      selectAgentForTeamRole({
        ...input,
        authorityRoles: { audit: authority },
        agents,
        requestedSelection: { mode: 'fixed', agent_id: 'a' },
      }).status
    ).toBe('unfilled');
  });
  it('cannot use a fixed implementer as its own reviewer when no alternative exists', () => {
    expect(
      selectAgentForTeamRole({
        ...input,
        agents: { a: input.agents.a! },
        separation: { excludeAgents: ['a'] },
        requestedSelection: { mode: 'fixed', agent_id: 'a' },
      }).status
    ).toBe('unfilled');
  });
  it('prioritizes an eligible preferred identity over legacy role hints', () => {
    const result = selectAgentForTeamRole({
      ...input,
      requestedSelection: { mode: 'preferred', agent_id: 'b' },
    });
    expect(result.agent_id).toBe('b');
    expect(result.selection_resolution?.source).toBe('requested');
  });
  it('discloses preferred fallback and preserves unchanged legacy behavior', () => {
    const preferred = selectAgentForTeamRole({
      ...input,
      requestedSelection: { mode: 'preferred', agent_id: 'missing' },
    });
    expect(preferred.agent_id).toBe('a');
    expect(preferred.selection_resolution?.source).toBe('fallback');
    const legacy = selectAgentForTeamRole({ ...input, separation: { excludeAgents: ['a', 'b'] } });
    expect(legacy.status).toBe('assigned');
    expect(legacy.requested_selection).toBeUndefined();
  });
  it('rejects contradictory auto targets and malformed fixed settings', () => {
    expect(() => normalizeMissionTeamRoleSelection({ mode: 'auto', agent_id: 'a' })).toThrow(
      'INVALID'
    );
    expect(() => normalizeMissionTeamRoleSelection({ mode: 'fixed' })).toThrow('INVALID');
  });
});
