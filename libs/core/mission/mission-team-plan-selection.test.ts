import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionTeamPlan, MissionTeamAssignment } from './mission-team-plan-composer.js';
const mocks = vi.hoisted(() => ({
  plan: {} as MissionTeamPlan,
  select: vi.fn(),
  write: vi.fn(),
  unavailable: false,
}));
vi.mock('../foundation/governed-catalog.js', () => ({
  defineCatalog: () => ({ load: () => mocks.plan, validate: (value: unknown) => value }),
}));
vi.mock('../foundation/time.js', () => ({ nowIso: () => '2026-10-12T00:00:00Z' }));
vi.mock('../foundation/lock-utils.js', () => ({
  withLockSync: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: (p: string) => p,
  safeExistsSync: () => true,
  safeLstat: () => ({ isFile: () => true }),
}));
vi.mock('../path-resolver.js', () => ({
  knowledge: (p: string) => p,
  findMissionPath: () => '/mission',
}));
vi.mock('./mission-state-reader.js', () => ({
  loadMissionStateAtPath: () => ({ tenant_slug: 'default' }),
}));
vi.mock('./mission-orchestration-journal.js', () => ({
  provisionMissionEntry: (value: unknown) => value,
  writeProvisionedJson: mocks.write,
}));
vi.mock('../organization/team-role-assignment-selection.js', () => ({
  selectAgentForTeamRole: mocks.select,
}));
vi.mock('../reasoning/reasoning-model-routing.js', () => ({
  resolveTaskModelHint: () => ({ model_id: 'hint' }),
}));
vi.mock('../workforce/workforce-load.js', () => ({ collectWorkforceLoad: () => ({}) }));
vi.mock('../organization/team-composition-obligations.js', () => ({
  matchTeamCompositionObligations: () => [],
  resolveAlwaysStaffedRoles: () => new Set(['owner']),
  resolveRosterHeadroom: () => 2,
}));
vi.mock('./mission-classification.js', () => ({
  mapMissionClassToMissionTypeTemplate: () => 'default',
  resolveMissionClassification: () => ({
    stage: 'execution',
    mission_class: 'development',
    risk_profile: 'low',
  }),
}));
vi.mock('./mission-team-index.js', () => ({
  loadAgentProfileIndex: () => ({
    a: { capabilities: ['code'], team_roles: ['owner', 'reviewer', 'expert'] },
    b: { capabilities: ['code'], team_roles: ['owner', 'reviewer', 'expert'] },
  }),
  loadAuthorityRoleIndex: () => ({}),
  loadMissionTeamTemplates: () => ({
    default: { required_roles: ['owner', 'reviewer'], optional_roles: [] },
  }),
  loadTeamRoleIndex: () =>
    Object.fromEntries(
      ['owner', 'reviewer', 'expert'].map((role) => [
        role,
        { required_capabilities: ['code'], selection_hints: {}, autonomy_level: 'high' },
      ])
    ),
}));
vi.mock('../organization/organization-profile.js', () => ({ loadOrganizationProfile: () => null }));
vi.mock('../org-chart.js', () => ({
  resolveOrganizationOrgChart: () => null,
  summarizeOrganizationOrgChart: () => undefined,
}));
vi.mock('../participant-context-resolver.js', () => ({
  resolveParticipantContext: (input: { security_scope: unknown }) => ({
    participant: { security_scope: input.security_scope },
    selection_reason_codes: [],
  }),
}));
vi.mock('../provider/provider-discovery.js', () => ({ discoverProviders: () => [] }));
vi.mock('../provider/provider-config.js', () => ({ isObsoleteAgentRuntimeProvider: () => false }));
import {
  resolveMissionTeamPlan,
  extendMissionTeamPlanRoster,
  promoteMissionTeamPlanRoles,
  resolveMissionTeamReceiver,
  writeMissionTeamPlan,
  missionTeamPlanRevision,
} from './mission-team-plan-composer.js';
const assignment = (
  role: string,
  actor: string,
  status: MissionTeamAssignment['status']
): MissionTeamAssignment => ({
  team_role: role,
  required: true,
  status,
  agent_id: actor,
  authority_role: 'worker',
  delegation_contract: null,
  provider: 'p',
  modelId: 'm',
  required_capabilities: ['code'],
  notes: 'fixture',
  security_scope: { tenant_id: 'default' } as MissionTeamAssignment['security_scope'],
});
beforeEach(() => {
  mocks.unavailable = false;
  mocks.select.mockReset();
  mocks.write.mockReset();
  mocks.plan = {
    mission_id: 'MSN-FIXTURE',
    mission_type: 'default',
    tier: 'public',
    tenant_slug: 'default',
    template: 'default',
    generated_at: 'before',
    selection_settings: {
      reviewer: { mode: 'fixed', agent_id: 'b', provider: 'p', model_id: 'm' },
    },
    assignments: [assignment('owner', 'a', 'assigned'), assignment('reviewer', 'b', 'standby')],
  };
  mocks.select.mockImplementation((input) => ({
    ...assignment(
      input.teamRole,
      input.requestedSelection?.agent_id || 'automatic',
      mocks.unavailable ? 'unfilled' : 'assigned'
    ),
    ...(mocks.unavailable ? { agent_id: null } : {}),
    requested_selection: input.requestedSelection,
    selection_resolution: {
      source: mocks.unavailable ? 'blocked' : 'requested',
      reason: 'checked',
    },
  }));
});
describe('mission plan selection persistence', () => {
  it('loads requested settings before forced recomposition and preserves fixed standby targets', () => {
    const plan = resolveMissionTeamPlan({
      missionId: 'MSN-FIXTURE',
      forceRefresh: true,
      tier: 'public',
    });
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        teamRole: 'reviewer',
        requestedSelection: mocks.plan.selection_settings?.reviewer,
      })
    );
    expect(plan.selection_settings).toEqual(mocks.plan.selection_settings);
    expect(plan.assignments.find((entry) => entry.team_role === 'reviewer')).toMatchObject({
      agent_id: 'b',
      status: 'standby',
      requested_selection: { mode: 'fixed', agent_id: 'b' },
    });
  });
  it('does not replace previously staffed owners during an explicit-policy refresh', () => {
    const plan = resolveMissionTeamPlan({
      missionId: 'MSN-FIXTURE',
      forceRefresh: true,
      tier: 'public',
    });
    expect(plan.assignments.find((entry) => entry.team_role === 'owner')?.agent_id).toBe('a');
  });
  it('retains blocked fixed intent instead of silently selecting another target', () => {
    mocks.unavailable = true;
    const plan = resolveMissionTeamPlan({
      missionId: 'MSN-FIXTURE',
      forceRefresh: true,
      tier: 'public',
    });
    expect(plan.selection_settings?.reviewer?.agent_id).toBe('b');
    expect(plan.assignments.find((entry) => entry.team_role === 'reviewer')?.status).toBe(
      'unfilled'
    );
  });
  it('carries requested settings through standby promotion', () => {
    const prior = mocks.plan.assignments[1]!;
    prior.requested_selection = mocks.plan.selection_settings?.reviewer;
    const promoted = promoteMissionTeamPlanRoles(mocks.plan, ['reviewer']).plan;
    expect(promoted.assignments[1]).toMatchObject({
      agent_id: 'b',
      status: 'assigned',
      requested_selection: prior.requested_selection,
    });
    expect(promoted.selection_settings).toEqual(mocks.plan.selection_settings);
  });
  it('uses the recorded policy while restaffing an additional role', () => {
    mocks.plan.selection_settings!.expert = { mode: 'fixed', agent_id: 'b' };
    const result = extendMissionTeamPlanRoster(mocks.plan, {
      teamRole: 'expert',
      requiredCapabilities: ['code'],
    });
    expect(result.added?.requested_selection).toEqual({ mode: 'fixed', agent_id: 'b' });
    expect(result.plan.selection_settings?.expert).toEqual({ mode: 'fixed', agent_id: 'b' });
  });
  it('carries policy and hard exclusions into receiver reselection', () => {
    resolveMissionTeamReceiver({
      missionId: 'MSN-FIXTURE',
      teamRole: 'reviewer',
      excludedAgentIds: ['a'],
      requiredCapabilities: ['code'],
    });
    expect(mocks.select).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestedSelection: mocks.plan.selection_settings?.reviewer,
        separation: { excludeAgents: ['a'] },
        tier: 'public',
      })
    );
  });
  it('rejects stale ordinary writers instead of dropping saved settings', () => {
    expect(() =>
      writeMissionTeamPlan('/mission', { ...mocks.plan, selection_settings: undefined })
    ).toThrow('STALE');
    expect(mocks.write).not.toHaveBeenCalled();
    writeMissionTeamPlan(
      '/mission',
      { ...mocks.plan, selection_settings: {} },
      { expectedRevision: missionTeamPlanRevision(mocks.plan) }
    );
    expect(mocks.write).toHaveBeenCalledOnce();
  });
});
