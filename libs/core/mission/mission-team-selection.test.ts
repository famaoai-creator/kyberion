import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionTeamPlan, MissionTeamAssignment } from './mission-team-plan-composer.js';
import type { MissionState } from './mission-types.js';
import type { WorkItem } from '../workforce/work-coordination.js';
import type { MissionExecutionLedgerEntry } from './mission-team-binding.js';
const state = vi.hoisted(() => ({
  plan: {} as MissionTeamPlan,
  mission: {} as MissionState & { project_id?: string },
  providers: [] as Array<{
    provider: string;
    installed: boolean;
    healthy: boolean;
    models: string[];
  }>,
  items: [] as WorkItem[],
  ledger: [] as MissionExecutionLedgerEntry[],
  events: [] as Array<Record<string, unknown>>,
  local: undefined as { status: string; spawnedAt?: number } | undefined,
  runtime: undefined as { state: string } | undefined,
  order: [] as string[],
  write: vi.fn(),
  bindings: vi.fn(),
  discover: vi.fn(),
  blocked: false,
  preferredActor: 'b',
  onLock: undefined as (() => void) | undefined,
}));
vi.mock('../provider/provider-discovery.js', () => ({
  peekProviderDiscovery: () => ({ providers: state.providers, source: 'memory' }),
  discoverProviders: state.discover,
}));
vi.mock('../agent/agent-registry.js', () => ({ agentRegistry: { get: () => state.local } }));
vi.mock('../tool/runtime-supervisor.js', () => ({
  runtimeSupervisor: { get: () => state.runtime },
}));
vi.mock('../agent/agent-runtime-events.js', () => ({
  readSupervisorEvents: () => state.events,
}));
vi.mock('../workforce/work-coordination.js', () => ({
  withWorkItemInventorySnapshot: (fn: (items: readonly WorkItem[]) => unknown) => {
    state.order.push('claims:enter');
    try {
      return fn(state.items);
    } finally {
      state.order.push('claims:exit');
    }
  },
}));
vi.mock('../workforce/workforce-load.js', () => ({ collectWorkforceLoad: () => ({}) }));
vi.mock('./mission-state-reader.js', () => ({ loadMissionStateAtPath: () => state.mission }));
vi.mock('./mission-team-index.js', () => ({
  loadAgentProfileIndex: () => ({
    a: { team_roles: ['implementer'] },
    b: { team_roles: ['implementer'] },
  }),
  loadAuthorityRoleIndex: () => ({}),
  loadTeamRoleIndex: () => ({
    implementer: { required_capabilities: ['coding'] },
    reviewer: { required_capabilities: ['review'] },
  }),
}));
vi.mock('./mission-team-plan-composer.js', () => ({
  getMissionTeamPlanPath: () => '/fixture/mission/team-composition.json',
  missionTeamPlanRevision: () => 'mock-plan-revision',
  loadMissionTeamPlan: () => state.plan,
  loadMissionTeamPlanAtPath: () => state.plan,
  enrichAssignmentContext: ({ assignment }: { assignment: MissionTeamAssignment }) => assignment,
  resolveRoleSeparation: () => undefined,
  SEPARATION_ROLE_PAIRS: [],
  withMissionTeamPlanMutation: (_dir: string, fn: () => unknown) => {
    state.order.push('plan:enter');
    state.onLock?.();
    try {
      return fn();
    } finally {
      state.order.push('plan:exit');
    }
  },
  writeMissionTeamPlan: (_dir: string, plan: MissionTeamPlan) => {
    state.order.push('write');
    state.plan = plan;
    state.write(plan);
  },
}));
vi.mock('./mission-team-binding.js', () => ({
  initializeMissionTeamBindings: state.bindings,
  readMissionExecutionLedger: () => state.ledger,
  appendMissionExecutionLedgerEntry: (input: MissionExecutionLedgerEntry) => {
    state.ledger.push({ ...input, ts: '2026-10-12T12:00:00.000Z' });
  },
}));
vi.mock('../organization/team-role-assignment-selection.js', () => {
  return {
    normalizeMissionTeamRoleSelection: (value: unknown) => value,
    selectAgentForTeamRole: (input: {
      requestedSelection: {
        mode: string;
        agent_id?: string;
        provider?: string;
        model_id?: string;
      };
      discoveredProviders: unknown[];
    }) => {
      const requested = input.requestedSelection;
      return {
        ...state.plan.assignments[0],
        agent_id:
          state.blocked || !input.discoveredProviders.length
            ? null
            : requested.agent_id || state.preferredActor,
        provider: requested.provider || 'p',
        modelId: requested.model_id || 'm',
        status: state.blocked || !input.discoveredProviders.length ? 'unfilled' : 'assigned',
        requested_selection: requested,
        selection_resolution: {
          source: state.blocked || !input.discoveredProviders.length ? 'blocked' : 'requested',
          reason: state.blocked ? 'target denied' : 'checked',
        },
      };
    },
  };
});
import {
  previewMissionTeamSelection,
  saveMissionTeamSelection,
  reserveMissionTeamSelectionDispatch,
  resolveMissionTeamSelectionScope,
} from './mission-team-selection.js';

beforeEach(() => {
  state.mission = {
    mission_id: 'MSN-FIXTURE',
    tier: 'public',
    status: 'active',
    tenant_slug: 'default',
  } as MissionState;
  state.plan = {
    mission_id: 'MSN-FIXTURE',
    mission_type: 'development',
    tier: 'public',
    tenant_slug: 'default',
    template: 'default',
    generated_at: 'now',
    assignments: [
      {
        team_role: 'implementer',
        required: true,
        status: 'assigned',
        agent_id: 'a',
        provider: 'p',
        modelId: 'm',
        authority_role: 'worker',
        delegation_contract: null,
        required_capabilities: ['coding'],
        notes: 'fixture',
      },
    ],
  };
  state.providers = [{ provider: 'p', installed: true, healthy: true, models: ['m'] }];
  state.items = [];
  state.ledger = [];
  state.events = [];
  state.local = undefined;
  state.runtime = undefined;
  state.order = [];
  state.blocked = false;
  state.preferredActor = 'b';
  state.onLock = undefined;
  state.write.mockClear();
  state.bindings.mockClear();
  state.discover.mockClear();
});
const save = (revision: string) =>
  saveMissionTeamSelection('MSN-FIXTURE', {
    team_role: 'implementer',
    selection: { mode: 'fixed', agent_id: 'b' },
    expected_revision: revision,
    expected_preview_token: previewMissionTeamSelection('MSN-FIXTURE', {
      team_role: 'implementer',
      selection: { mode: 'fixed', agent_id: 'b' },
    }).preview_token!,
  });
describe('mission selection preview and atomic save', () => {
  it('reports persisted effective assignment on GET even when preferred scoring would choose another actor', () => {
    state.plan.selection_settings = { implementer: { mode: 'preferred', provider: 'p' } };
    const view = previewMissionTeamSelection('MSN-FIXTURE');
    expect(view.roles[0]?.effective.agent_id).toBe('a');
    expect(view.preview_token).toBeUndefined();
    expect(view.roles[0]?.eligibility).toBeDefined();
  });
  it('keeps removed legacy catalog roles visible with blocked eligibility instead of crashing GET', () => {
    state.plan.assignments.push({ ...state.plan.assignments[0]!, team_role: 'retired-role' });
    const view = previewMissionTeamSelection('MSN-FIXTURE');
    expect(view.roles[1]?.effective.agent_id).toBe('a');
    expect(view.roles[1]?.eligibility).toEqual({
      eligible: false,
      reason: expect.stringContaining('Unknown team role'),
    });
    const selection = { mode: 'fixed' as const, agent_id: 'b' };
    const preview = previewMissionTeamSelection('MSN-FIXTURE', {
      team_role: 'retired-role',
      selection,
    });
    expect(preview.roles[0]?.source).toBe('blocked');
    expect(() =>
      saveMissionTeamSelection('MSN-FIXTURE', {
        team_role: 'retired-role',
        selection,
        expected_revision: preview.revision,
        expected_preview_token: preview.preview_token!,
      })
    ).toThrow('Unknown team role');
    expect(state.write).not.toHaveBeenCalled();
  });

  it('rejects preferred decision drift under the same content revision', () => {
    const selection = { mode: 'preferred' as const, provider: 'p' };
    const preview = previewMissionTeamSelection('MSN-FIXTURE', {
      team_role: 'implementer',
      selection,
    });
    expect(preview.roles[0]?.effective.agent_id).toBe('b');
    state.preferredActor = 'a';
    expect(previewMissionTeamSelection('MSN-FIXTURE').revision).toBe(preview.revision);
    expect(() =>
      saveMissionTeamSelection('MSN-FIXTURE', {
        team_role: 'implementer',
        selection,
        expected_revision: preview.revision,
        expected_preview_token: preview.preview_token!,
      })
    ).toThrow('previewed actor');
    expect(state.write).not.toHaveBeenCalled();
  });
  it('returns the persisted previewed target even if scores change after writing', () => {
    const selection = { mode: 'preferred' as const, provider: 'p' };
    const preview = previewMissionTeamSelection('MSN-FIXTURE', {
      team_role: 'implementer',
      selection,
    });
    state.bindings.mockImplementationOnce(() => {
      state.preferredActor = 'a';
    });
    const receipt = saveMissionTeamSelection('MSN-FIXTURE', {
      team_role: 'implementer',
      selection,
      expected_revision: preview.revision,
      expected_preview_token: preview.preview_token!,
    });
    expect(state.plan.assignments[0]?.agent_id).toBe('b');
    expect(receipt.roles[0]?.effective.agent_id).toBe('b');
  });
  it('canonicalizes scope aliases and rejects conflicts or an under-lock alias move', () => {
    state.mission.relationships = { organization: { organization_id: 'org' } };
    state.mission.project_id = 'project';
    const expected = resolveMissionTeamSelectionScope(state.mission);
    expect(expected).toMatchObject({ organization_id: 'org', project_id: 'project' });
    expect(() =>
      resolveMissionTeamSelectionScope({ ...state.mission, organization_id: 'different' })
    ).toThrow('Conflicting');
    const selection = { mode: 'fixed' as const, agent_id: 'b' };
    const preview = previewMissionTeamSelection('MSN-FIXTURE', {
      team_role: 'implementer',
      selection,
      expected_scope: expected,
    });
    state.onLock = () => {
      state.mission.project_id = 'moved';
    };
    expect(() =>
      saveMissionTeamSelection('MSN-FIXTURE', {
        team_role: 'implementer',
        selection,
        expected_revision: preview.revision,
        expected_preview_token: preview.preview_token!,
        expected_scope: expected,
      })
    ).toThrow('scope changed');
  });
  it('requires matching runtime generation and mission in later stop proof', () => {
    state.plan.selection_settings = { implementer: { mode: 'fixed', agent_id: 'a' } };
    state.local = { status: 'shutdown', spawnedAt: 123 };
    reserveMissionTeamSelectionDispatch({
      missionId: 'MSN-FIXTURE',
      teamRole: 'implementer',
      agentId: 'a',
    });
    state.local = undefined;
    state.events = [
      {
        agent_id: 'a',
        decision: 'agent_runtime_stopped',
        ts: '2026-10-12T13:00:00.000Z',
        scope: { mission_id: 'MSN-FIXTURE' },
        runtime_generation: 456,
      },
    ];
    expect(() => save(previewMissionTeamSelection('MSN-FIXTURE').revision)).toThrow(
      'runtime generation'
    );
    state.events[0]!.runtime_generation = 123;
    state.events[0]!.scope = { mission_id: 'OTHER-MISSION' };
    expect(() => save(previewMissionTeamSelection('MSN-FIXTURE').revision)).toThrow(
      'runtime generation'
    );
    state.events[0]!.scope = { mission_id: 'MSN-FIXTURE' };
    expect(
      save(previewMissionTeamSelection('MSN-FIXTURE').revision).roles[0]?.effective.agent_id
    ).toBe('b');
  });
  it('does not replace a captured reservation generation with a later runtime generation', () => {
    state.plan.selection_settings = { implementer: { mode: 'fixed', agent_id: 'a' } };
    state.local = { status: 'shutdown', spawnedAt: 123 };
    reserveMissionTeamSelectionDispatch({
      missionId: 'MSN-FIXTURE',
      teamRole: 'implementer',
      agentId: 'a',
    });
    state.local = undefined;
    state.events = [
      {
        agent_id: 'a',
        decision: 'agent_runtime_ensure_completed',
        ts: '2026-10-12T12:01:00.000Z',
        scope: { mission_id: 'MSN-FIXTURE' },
        runtime_generation: 456,
      },
      {
        agent_id: 'a',
        decision: 'agent_runtime_stopped',
        ts: '2026-10-12T13:00:00.000Z',
        scope: { mission_id: 'MSN-FIXTURE' },
        runtime_generation: 456,
      },
    ];
    expect(() => save(previewMissionTeamSelection('MSN-FIXTURE').revision)).toThrow(
      'runtime generation'
    );
    expect(state.write).not.toHaveBeenCalled();
  });

  it('links a new runtime generation from ensure evidence before accepting its stop', () => {
    state.plan.selection_settings = { implementer: { mode: 'fixed', agent_id: 'a' } };
    reserveMissionTeamSelectionDispatch({
      missionId: 'MSN-FIXTURE',
      teamRole: 'implementer',
      agentId: 'a',
    });
    state.events = [
      {
        agent_id: 'a',
        decision: 'agent_runtime_ensure_completed',
        ts: '2026-10-12T12:01:00.000Z',
        scope: { mission_id: 'MSN-FIXTURE' },
        runtime_generation: 234,
      },
      {
        agent_id: 'a',
        decision: 'agent_runtime_stopped',
        ts: '2026-10-12T13:00:00.000Z',
        scope: { mission_id: 'MSN-FIXTURE' },
        runtime_generation: 234,
      },
    ];
    expect(
      save(previewMissionTeamSelection('MSN-FIXTURE').revision).roles[0]?.effective.agent_id
    ).toBe('b');
  });

  it('reads configured/effective/source/reason with no probe or write, even on a cold cache', () => {
    state.providers = [];
    const result = previewMissionTeamSelection('MSN-FIXTURE', {
      team_role: 'implementer',
      selection: { mode: 'fixed', agent_id: 'b' },
    });
    expect(result.roles[0]?.source).toBe('blocked');
    expect(result.roles[0]?.configured.agent_id).toBe('b');
    expect(state.discover).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
    expect(state.ledger).toHaveLength(0);
  });
  it('allows assigned-but-idle configuration, preserves unrelated roles and writes under both fences', () => {
    state.plan.assignments.push({
      ...state.plan.assignments[0]!,
      team_role: 'reviewer',
      agent_id: 'reviewer',
    });
    const prior = state.plan.assignments[1];
    const result = save(previewMissionTeamSelection('MSN-FIXTURE').revision);
    expect(result.roles[0]?.configured).toEqual({ mode: 'fixed', agent_id: 'b' });
    expect(state.plan.assignments[1]).toBe(prior);
    expect(state.plan.assignments[0]?.status).toBe('assigned');
    expect(state.order).toEqual([
      'plan:enter',
      'claims:enter',
      'write',
      'claims:exit',
      'plan:exit',
    ]);
    expect(state.bindings).toHaveBeenCalledOnce();
  });
  it('rejects concurrent plan changes observed only after taking the lock', () => {
    const revision = previewMissionTeamSelection('MSN-FIXTURE').revision;
    state.onLock = () => {
      state.plan.generated_at = 'changed';
    };
    expect(() => save(revision)).toThrow('STALE');
    expect(state.write).not.toHaveBeenCalled();
  });
  it('binds revision to mission scope and provider snapshot', () => {
    const revision = previewMissionTeamSelection('MSN-FIXTURE').revision;
    state.providers[0]!.models.push('m2');
    expect(() => save(revision)).toThrow('STALE');
    expect(() =>
      previewMissionTeamSelection('MSN-FIXTURE', { expected_scope: { tier: 'personal' } })
    ).toThrow('STALE');
  });
  it('rejects an in-flight claim appearing before the claim-fenced read', () => {
    const revision = previewMissionTeamSelection('MSN-FIXTURE').revision;
    state.onLock = () => {
      state.items = [
        {
          context: { mission_id: 'MSN-FIXTURE', tenant_slug: 'default' },
          metadata: { team_role: 'implementer' },
          status: 'in_progress',
          labels: [],
          lease_id: 'lease',
        } as unknown as WorkItem,
      ];
    };
    expect(() => save(revision)).toThrow('ACTIVE');
    expect(state.write).not.toHaveBeenCalled();
  });
  it('blocks same-mission legacy claims without tenant context but excludes explicitly different tenants', () => {
    const revision = previewMissionTeamSelection('MSN-FIXTURE').revision;
    state.items = [
      {
        metadata: { mission_id: 'MSN-FIXTURE', team_role: 'implementer' },
        status: 'in_progress',
        labels: [],
        lease_id: 'lease',
      } as unknown as WorkItem,
    ];
    expect(() => save(revision)).toThrow('ACTIVE');
    state.items[0]!.context = { mission_id: 'MSN-FIXTURE', tenant_slug: 'other-tenant' };
    expect(save(revision).roles[0]?.effective.agent_id).toBe('b');
  });

  it('rejects active runtime without a task claim', () => {
    state.local = { status: 'ready' };
    expect(() => save(previewMissionTeamSelection('MSN-FIXTURE').revision)).toThrow('ACTIVE');
  });
  it('rejects unknown daemon liveness until a confirmed stop', () => {
    state.events = [
      { agent_id: 'a', decision: 'agent_runtime_ensure_requested', ts: '2026-10-12T11:00:00Z' },
    ];
    expect(() => save(previewMissionTeamSelection('MSN-FIXTURE').revision)).toThrow('ACTIVE');
    state.events.push({
      agent_id: 'a',
      decision: 'agent_runtime_stopped',
      ts: '2026-10-12T13:00:00Z',
    });
    expect(
      save(previewMissionTeamSelection('MSN-FIXTURE').revision).roles[0]?.effective.agent_id
    ).toBe('b');
  });
  it('never persists a blocked fixed request', () => {
    state.blocked = true;
    expect(() => save(previewMissionTeamSelection('MSN-FIXTURE').revision)).toThrow(
      'target denied'
    );
    expect(state.write).not.toHaveBeenCalled();
  });
  it('reserves a launch durably, deduplicates retries and blocks a later save after a process restart', () => {
    state.plan.selection_settings = { implementer: { mode: 'fixed', agent_id: 'a' } };
    const input = {
      missionId: 'MSN-FIXTURE',
      teamRole: 'implementer',
      agentId: 'a',
      provider: 'p',
      modelId: 'm',
      expectedRequestedSelection: { mode: 'fixed' as const, agent_id: 'a' },
    };
    reserveMissionTeamSelectionDispatch(input);
    reserveMissionTeamSelectionDispatch(input);
    expect(state.ledger).toHaveLength(1);
    state.local = undefined;
    state.runtime = undefined;
    expect(() => save(previewMissionTeamSelection('MSN-FIXTURE').revision)).toThrow('reservation');
  });
  it('reserves a runtime-only role only through the explicit runtime launch route', () => {
    state.plan.selection_settings = {
      implementer: {
        mode: 'fixed',
        agent_id: 'a',
        execution_route: 'agent_runtime',
      },
    };
    const input = { missionId: 'MSN-FIXTURE', teamRole: 'implementer', agentId: 'a' };
    expect(() => reserveMissionTeamSelectionDispatch(input)).toThrow(
      'agent_runtime launch reservation'
    );
    expect(state.ledger).toHaveLength(0);
    expect(
      reserveMissionTeamSelectionDispatch({ ...input, executionRoute: 'agent_runtime' })
    ).toMatchObject({ agent_id: 'a' });
    expect(state.ledger).toHaveLength(1);
  });
  it('does not treat a same-timestamp stop as proof that a reserved launch ended', () => {
    state.plan.selection_settings = { implementer: { mode: 'fixed', agent_id: 'a' } };
    reserveMissionTeamSelectionDispatch({
      missionId: 'MSN-FIXTURE',
      teamRole: 'implementer',
      agentId: 'a',
    });
    state.events = [
      { agent_id: 'a', decision: 'agent_runtime_stopped', ts: '2026-10-12T12:00:00.000Z' },
    ];
    expect(() => save(previewMissionTeamSelection('MSN-FIXTURE').revision)).toThrow('reservation');
  });

  it('rejects a mode-only policy race before writing a reservation', () => {
    state.plan.selection_settings = { implementer: { mode: 'fixed', agent_id: 'a' } };
    expect(() =>
      reserveMissionTeamSelectionDispatch({
        missionId: 'MSN-FIXTURE',
        teamRole: 'implementer',
        agentId: 'a',
        expectedRequestedSelection: { mode: 'preferred', agent_id: 'a' },
      })
    ).toThrow('STALE');
    expect(state.ledger).toHaveLength(0);
  });
  it('does not reserve failed pure eligibility preflight', () => {
    state.plan.selection_settings = { implementer: { mode: 'fixed', agent_id: 'a' } };
    state.blocked = true;
    expect(() =>
      reserveMissionTeamSelectionDispatch({
        missionId: 'MSN-FIXTURE',
        teamRole: 'implementer',
        agentId: 'a',
      })
    ).toThrow('INVALID');
    expect(state.ledger).toHaveLength(0);
  });
});
