import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { safeMkdir, safeRmSync } from './secure-io.js';
import { loadProvisionedEntryRecords } from './mission-orchestration-journal.js';
import { composeMissionTeamBrief, writeMissionTeamBrief } from './mission-team-brief-composer.js';
import {
  composeMissionTeamPlan,
  diagnoseMissionTeamRoleGap,
  extendMissionTeamPlanRoster,
  loadMissionTeamPlan,
  promoteMissionTeamPlanRoles,
  resolveMissionTeamReceiver,
  resolveMissionTeamPlan,
  writeMissionTeamPlan,
} from './mission-team-plan-composer.js';
import { discoverProviders } from './provider-discovery.js';
import { loadAgentProfileIndex } from './mission-team-index.js';

describe('mission-team-composer classification integration', () => {
  it('derives mission type from mission classification when missionType is omitted', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-CLASS-001',
      intentId: 'bootstrap-project',
      shape: 'project_bootstrap',
      progressSignals: ['classified'],
      tier: 'confidential',
    });

    expect(plan.mission_type).toBe('product_development');
    expect(plan.template).toBe('product_development');
    expect(plan.team_governance?.composition.required_roles).toContain('orchestrator');
    expect(
      plan.assignments.find((assignment) => assignment.team_role === 'owner')?.delegation_contract
        ?.allowed_delegate_team_roles
    ).toContain('orchestrator');
    expect(plan.mission_classification?.mission_class).toBe('product_delivery');
    expect(plan.mission_classification?.stage).toBe('classification');

    const owner = plan.assignments.find((assignment) => assignment.team_role === 'owner');
    expect(owner?.status).toBe('assigned');
    expect(owner?.model_hint).toEqual(
      expect.objectContaining({
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.6-luna',
      })
    );
    expect(owner?.delegation_contract?.ownership_scope).toContain('end-to-end mission objective');
    expect(owner?.delegation_contract?.allowed_delegate_team_roles).toContain('planner');
    expect(owner?.delegation_contract?.resolved_scope_classes).toContain('mission_state');
    expect(owner?.delegation_contract?.allowed_write_scopes.length).toBeGreaterThan(0);
  });

  it('routes research missions through the researcher role and separates it from the owner', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-RESEARCH-001',
      missionType: 'research',
      intentId: 'market-research',
      shape: 'research',
      progressSignals: ['classified'],
      tier: 'public',
    });

    expect(plan.template).toBe('research');
    const owner = plan.assignments.find((assignment) => assignment.team_role === 'owner');
    const researcher = plan.assignments.find((assignment) => assignment.team_role === 'researcher');
    expect(researcher?.status).toBe('standby');
    expect(researcher?.agent_id).toBeTruthy();
    expect(researcher?.agent_id).not.toBe(owner?.agent_id);
    expect(researcher?.delegation_contract?.ownership_scope).toContain('research packet');
    expect(researcher?.model_hint?.model_id).toBe('openai:gpt-5.6-luna');
  });

  it('applies organization defaults when composing the team plan', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-ORG-001',
      missionType: 'development',
      intentId: 'bootstrap-project',
      shape: 'project_bootstrap',
      progressSignals: ['classified'],
      tier: 'confidential',
      organizationProfile: {
        version: '1.0.0',
        organization_id: 'demo-org',
        name: 'Demo Org',
        mission_defaults: {
          default_team_template: 'default',
          default_agent_profile: 'planner-agent',
        },
        team_defaults: {
          default_team_template: 'default',
          team_template_catalog_id: 'demo-org',
        },
        llm: {},
      },
    });

    expect(plan.template).toBe('development');
    expect(plan.organization_profile?.team_template_catalog_id).toBe('demo-org');
    // TC-04: this mission classifies as approval_required, so the
    // `human-approval-routing` obligation lifts surface_liaison out of the
    // template's optional list into the required roster.
    expect(plan.team_governance?.composition.required_roles).toContain('surface_liaison');
    expect(plan.team_governance?.composition.optional_roles).not.toContain('surface_liaison');
    expect(
      plan.assignments.find((assignment) => assignment.team_role === 'surface_liaison')
        ?.role_sources
    ).toEqual(['obligation', 'template']);
    expect(plan.team_governance?.obligations?.map((entry) => entry.id)).toContain(
      'human-approval-routing'
    );
    expect(plan.team_governance?.lifecycle.max_messages_per_run).toBe(75);
    const planner = plan.assignments.find((assignment) => assignment.team_role === 'planner');
    expect(planner?.agent_id).toBe('planner-agent');
  });

  it('uses the mission tenant for every participant security scope', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-TENANT-SCOPE-001',
      missionType: 'development',
      tier: 'confidential',
      tenantSlug: 'kyberion-service-studio',
      organizationProfile: {
        version: '1.0.0',
        organization_id: 'kyberion-development-team',
        name: 'Kyberion Development Team',
        mission_defaults: { default_team_template: 'default' },
        team_defaults: { default_team_template: 'default', team_template_catalog_id: 'saas' },
        llm: {},
      },
    });

    expect(plan.tenant_slug).toBe('kyberion-service-studio');
    expect(
      plan.assignments
        .filter((assignment) => assignment.status === 'assigned')
        .every((assignment) => assignment.security_scope?.tenant_id === 'kyberion-service-studio')
    ).toBe(true);
  });

  it('honors an explicitly selected available provider for every team role', () => {
    const available = discoverProviders()
      .filter((entry) => entry.installed && entry.healthy && entry.provider !== 'gemini')
      .map((entry) => entry.provider);
    if (!available.includes('codex')) return;

    const plan = composeMissionTeamPlan({
      missionId: 'MSN-PROVIDER-SELECTION-001',
      missionType: 'development',
      tier: 'confidential',
      tenantSlug: 'kyberion-service-studio',
      providerPreference: { provider: 'codex', modelId: 'codex' },
    });

    expect(plan.provider_selection).toEqual(
      expect.objectContaining({
        requested_provider: 'codex',
        requested_model_id: 'codex',
      })
    );
    expect(
      plan.assignments
        .filter((assignment) => assignment.status === 'assigned')
        .every((assignment) => assignment.provider === 'codex' && assignment.modelId === 'codex')
    ).toBe(true);
  });

  it('rejects obsolete Gemini ACP even when discovery still reports it installed', () => {
    expect(() =>
      composeMissionTeamPlan({
        missionId: 'MSN-PROVIDER-SELECTION-GEMINI-001',
        missionType: 'development',
        tier: 'public',
        providerPreference: { provider: 'gemini' },
      })
    ).toThrow(/TEAM_PROVIDER_UNAVAILABLE/);
  });

  it('refreshes an existing plan when an explicit tenant changes', () => {
    const missionId = 'MSN-TENANT-RESELECT-001';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'mission-controller-test';
    try {
      safeMkdir(missionPath, { recursive: true });
      const original = composeMissionTeamPlan({
        missionId,
        missionType: 'development',
        tier: 'public',
        tenantSlug: 'tenant-a',
      });
      writeMissionTeamPlan(missionPath, original);

      const refreshed = resolveMissionTeamPlan({
        missionId,
        missionType: 'development',
        tier: 'public',
        tenantSlug: 'tenant-b',
      });

      expect(refreshed.tenant_slug).toBe('tenant-b');
      expect(
        refreshed.assignments
          .filter((assignment) => assignment.status === 'assigned')
          .every((assignment) => assignment.security_scope?.tenant_id === 'tenant-b')
      ).toBe(true);
    } finally {
      safeRmSync(missionPath, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });

  it('refreshes a persisted plan that uses an obsolete agent-runtime provider', () => {
    const missionId = 'MSN-OBSOLETE-PROVIDER-001';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'mission-controller-test';
    try {
      safeMkdir(missionPath, { recursive: true });
      const original = composeMissionTeamPlan({
        missionId,
        missionType: 'development',
        tier: 'public',
        tenantSlug: 'tenant-a',
      });
      const stale = {
        ...original,
        assignments: original.assignments.map((assignment) =>
          assignment.team_role === 'orchestrator'
            ? { ...assignment, provider: 'gemini', modelId: 'auto-gemini-2.5' }
            : assignment
        ),
      };
      writeMissionTeamPlan(missionPath, stale);

      const refreshed = resolveMissionTeamPlan({
        missionId,
        missionType: 'development',
        tier: 'public',
        tenantSlug: 'tenant-a',
      });

      expect(
        refreshed.assignments.find((assignment) => assignment.team_role === 'orchestrator')
      ).toEqual(
        expect.objectContaining({
          provider: expect.not.stringMatching(/^gemini$/),
        })
      );
    } finally {
      safeRmSync(missionPath, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });

  it('rejects schema-invalid and cross-mission persisted team plans', () => {
    const missionId = 'MSN-TEAM-PLAN-SCOPE-001';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'mission-controller-test';
    try {
      safeMkdir(missionPath, { recursive: true });
      const plan = composeMissionTeamPlan({
        missionId,
        missionType: 'development',
        tier: 'public',
      });
      writeMissionTeamPlan(missionPath, { ...plan, mission_id: 'MSN-OTHER-001' });

      expect(() => loadMissionTeamPlan(missionId)).toThrow('[MISSION_TEAM_PLAN_SCOPE_MISMATCH]');

      writeMissionTeamPlan(missionPath, { ...plan, assignments: null as never });
      expect(() => loadMissionTeamPlan(missionId)).toThrow(/Invalid catalog mission-team-plan/);
    } finally {
      safeRmSync(missionPath, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });

  it('applies ops-oriented organization template overlays when composing an operations team plan', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-OPS-001',
      missionType: 'operations',
      intentId: 'run-ops',
      shape: 'operations',
      progressSignals: ['classified'],
      tier: 'public',
      organizationProfile: {
        version: '1.0.0',
        organization_id: 'ops-org',
        name: 'Ops Org',
        mission_defaults: {
          default_team_template: 'operations',
          default_agent_profile: 'operator-agent',
        },
        team_defaults: {
          default_team_template: 'operations',
          team_template_catalog_id: 'ops-org',
        },
        llm: {},
      },
    });

    expect(plan.template).toBe('operations');
    expect(plan.organization_profile?.team_template_catalog_id).toBe('ops-org');
    expect(plan.team_governance?.composition.optional_roles).toContain('surface_liaison');
    expect(plan.team_governance?.composition.optional_roles).toContain('decision_maker');
    expect(plan.team_governance?.lifecycle.max_messages_per_run).toBe(65);
    expect(plan.team_governance?.lifecycle.max_wall_clock_minutes).toBe(240);
  });

  it('uses the meeting facilitation team template when the mission type matches', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-MEET-001',
      missionType: 'meeting_facilitation',
      intentId: 'meeting-operations',
      taskType: 'meeting_operations',
      shape: 'mission',
      progressSignals: ['classified'],
      tier: 'public',
    });

    expect(plan.template).toBe('meeting_facilitation');
    expect(plan.team_governance?.composition.required_roles).toEqual(
      expect.arrayContaining(['owner', 'planner', 'operator', 'reviewer'])
    );
    expect(plan.team_governance?.composition.optional_roles).toEqual([]);
    expect(plan.team_governance?.lifecycle.max_member_turns).toBe(4);
  });

  it('composes a security scan team with attacker and defender roles assigned', () => {
    const plan = composeMissionTeamPlan({
      missionId: 'MSN-SEC-001',
      missionType: 'security_scan',
      intentId: 'scan-for-vulns',
      shape: 'security_scan',
      progressSignals: ['classified'],
      tier: 'confidential',
      organizationProfile: {
        version: '1.0.0',
        organization_id: 'sec-org',
        name: 'Security Org',
        mission_defaults: {
          default_team_template: 'security_scan',
          default_agent_profile: 'nerve-agent',
        },
        team_defaults: {
          default_team_template: 'security_scan',
          team_template_catalog_id: 'sec-org',
        },
        llm: {},
      },
    });

    expect(plan.template).toBe('security_scan');
    expect(plan.team_governance?.composition.required_roles).toEqual(
      expect.arrayContaining(['attacker', 'defender'])
    );
    expect(
      plan.assignments.find((assignment) => assignment.team_role === 'attacker')?.agent_id
    ).toBe('nerve-agent');
    expect(
      plan.assignments.find((assignment) => assignment.team_role === 'defender')?.agent_id
    ).toBe('sovereign-brain');
  });

  it('selects a capable reviewer while excluding the implementation agent', () => {
    const missionId = 'MSN-INDEPENDENT-REVIEWER-001';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'mission-controller-test';
    try {
      safeMkdir(missionPath, { recursive: true });
      const plan = composeMissionTeamPlan({
        missionId,
        missionType: 'product_development',
        intentId: 'bootstrap-project',
        shape: 'project_bootstrap',
        progressSignals: ['classified'],
        tier: 'public',
      });
      const reviewer = plan.assignments.find((assignment) => assignment.team_role === 'reviewer');
      expect(reviewer?.agent_id).toBeTruthy();
      const implementationAgentId = reviewer!.agent_id!;
      writeMissionTeamPlan(missionPath, plan);
      expect(
        loadProvisionedEntryRecords(missionId)
          .filter((record) => record.phase === 'verified')
          .map((record) => record.target_path)
      ).toContain('team-composition.json');

      const selected = resolveMissionTeamReceiver({
        missionId,
        teamRole: 'reviewer',
        excludedAgentIds: [implementationAgentId],
        requiredCapabilities: ['review', 'documentation', 'analysis'],
      });

      // The contract is "capable and not the excluded actor", not "this
      // particular agent". Which qualified candidate wins is a preference and
      // scoring detail that legitimately moves as the pool grows.
      expect(selected?.agent_id).toBeTruthy();
      expect(selected?.agent_id).not.toBe(implementationAgentId);
      expect(loadAgentProfileIndex()[selected!.agent_id!]?.capabilities).toEqual(
        expect.arrayContaining(['review', 'documentation', 'analysis'])
      );
      expect(selected?.required_capabilities).toEqual(
        expect.arrayContaining(['review', 'documentation', 'analysis'])
      );

      const codeReviewer = resolveMissionTeamReceiver({
        missionId,
        teamRole: 'reviewer',
        excludedAgentIds: ['reasoning-worker'],
        requiredCapabilities: ['review', 'code', 'testing'],
      });
      expect(codeReviewer?.agent_id).toBe('implementation-architect');
    } finally {
      safeRmSync(missionPath, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });

  it('records a composed team brief through the provisioned receipt contract', () => {
    const missionId = 'MSN-TEAM-BRIEF-RECEIPT-001';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionPath, { recursive: true });
    });
    try {
      const brief = composeMissionTeamBrief({
        missionId,
        missionType: 'product_development',
        request: 'Prepare a product development plan.',
        tier: 'public',
      });
      const receiptTargets = withExecutionContext('mission_controller', () => {
        const targetPath = writeMissionTeamBrief(missionPath, brief);
        return {
          targetPath,
          targets: loadProvisionedEntryRecords(missionId)
            .filter((record) => record.phase === 'verified')
            .map((record) => record.target_path),
        };
      });

      expect(receiptTargets.targetPath).toBe(`${missionPath}/evidence/team-composition-brief.json`);
      expect(receiptTargets.targets).toContain('evidence/team-composition-brief.json');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });
});

describe('demand-driven staffing (TC-01/TC-02)', () => {
  const composeDevelopmentPlan = () =>
    composeMissionTeamPlan({
      missionId: 'MSN-STAFFING-001',
      missionType: 'development',
      tier: 'public',
    });

  it('staffs only the structural roles and keeps the rest on standby', () => {
    const plan = composeDevelopmentPlan();

    expect(plan.team_governance?.composition.assigned_roles).toEqual(['owner', 'orchestrator']);
    const nonStructural = plan.assignments.filter(
      (assignment) => !['owner', 'orchestrator'].includes(assignment.team_role)
    );
    expect(nonStructural.length).toBeGreaterThan(0);
    for (const assignment of nonStructural) {
      expect(assignment.status).toBe('standby');
      // The candidate is resolved at composition time, so a staffing gap is
      // visible now and promotion never has to re-run selection.
      expect(assignment.agent_id).toBeTruthy();
      expect(assignment.authority_role).toBeTruthy();
    }
  });

  it('does not count standby roles as unfilled required roles', () => {
    const plan = composeDevelopmentPlan();
    expect(plan.team_governance?.composition.unfilled_required_roles).toEqual([]);
    expect(plan.team_governance?.composition.standby_roles).toEqual(
      expect.arrayContaining(['implementer', 'reviewer'])
    );
  });

  it('composes the same candidates on every run', () => {
    const first = composeDevelopmentPlan();
    const second = composeDevelopmentPlan();
    expect(
      second.assignments.map((entry) => [entry.team_role, entry.status, entry.agent_id])
    ).toEqual(first.assignments.map((entry) => [entry.team_role, entry.status, entry.agent_id]));
  });

  it('promotes only the demanded standby roles', () => {
    const plan = composeDevelopmentPlan();
    const before = plan.assignments.find((entry) => entry.team_role === 'implementer');

    const { plan: promotedPlan, promoted } = promoteMissionTeamPlanRoles(plan, ['implementer']);

    expect(promoted).toEqual(['implementer']);
    const implementer = promotedPlan.assignments.find((entry) => entry.team_role === 'implementer');
    expect(implementer?.status).toBe('assigned');
    // Promotion is a pure state transition over the recorded candidate.
    expect(implementer?.agent_id).toBe(before?.agent_id);
    expect(implementer?.provider).toBe(before?.provider);
    expect(promotedPlan.team_governance?.composition.assigned_roles).toContain('implementer');
    expect(promotedPlan.team_governance?.composition.standby_roles).not.toContain('implementer');
    expect(promotedPlan.assignments.find((entry) => entry.team_role === 'reviewer')?.status).toBe(
      'standby'
    );
  });

  it('leaves the plan untouched when nothing is promotable', () => {
    const plan = composeDevelopmentPlan();
    const { plan: unchanged, promoted } = promoteMissionTeamPlanRoles(plan, ['owner']);
    expect(promoted).toEqual([]);
    expect(unchanged).toBe(plan);
  });
});

describe('staffing state across recomposition (TC-01)', () => {
  it('keeps already staffed roles staffed when the plan is refreshed', () => {
    const missionId = 'MSN-STAFFING-REFRESH';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    try {
      withExecutionContext('mission_controller', () => {
        safeMkdir(missionPath, { recursive: true });
        const initial = composeMissionTeamPlan({
          missionId,
          missionType: 'development',
          tier: 'public',
        });
        const { plan: staffed } = promoteMissionTeamPlanRoles(initial, ['implementer']);
        writeMissionTeamPlan(missionPath, staffed);

        const refreshed = resolveMissionTeamPlan({ missionId, forceRefresh: true });
        expect(
          refreshed.assignments.find((entry) => entry.team_role === 'implementer')?.status
        ).toBe('assigned');
        expect(refreshed.assignments.find((entry) => entry.team_role === 'tester')?.status).toBe(
          'standby'
        );
      });
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });
});

describe('mid-mission restaffing (TC-06)', () => {
  const developmentPlan = () =>
    composeMissionTeamPlan({
      missionId: 'MSN-RESTAFF-001',
      missionType: 'development',
      tier: 'public',
    });

  it('adds a role the roster does not carry', () => {
    const plan = developmentPlan();
    expect(plan.assignments.some((entry) => entry.team_role === 'researcher')).toBe(false);

    const {
      plan: extended,
      added,
      refusal,
    } = extendMissionTeamPlanRoster(plan, {
      teamRole: 'researcher',
    });

    expect(refusal).toBeUndefined();
    expect(added?.team_role).toBe('researcher');
    expect(added?.agent_id).toBeTruthy();
    expect(added?.role_sources).toEqual(['restaff']);
    // A restaffed member is demanded now, so it joins staffed rather than on standby.
    expect(added?.status).toBe('assigned');
    expect(extended.team_governance?.composition.assigned_roles).toContain('researcher');
    expect(extended.team_governance?.composition.required_roles).toContain('researcher');
  });

  it('applies the same separation-of-duties rules as composition', () => {
    const plan = developmentPlan();
    const owner = plan.assignments.find((entry) => entry.team_role === 'owner');
    const { added } = extendMissionTeamPlanRoster(plan, { teamRole: 'researcher' });
    // researcher must be independent of the owner
    expect(added?.agent_id).not.toBe(owner?.agent_id);
  });

  it('leaves the lifecycle cap real headroom above the composed roster', () => {
    const plan = developmentPlan();
    // Every authored template declares max_members == its own roster size,
    // which made the cap unreachable and blocked all restaffing.
    expect(plan.team_governance?.lifecycle.max_members).toBeGreaterThan(plan.assignments.length);
  });

  it('refuses a role that is already on the roster', () => {
    const plan = developmentPlan();
    const { added, refusal } = extendMissionTeamPlanRoster(plan, { teamRole: 'reviewer' });
    expect(added).toBeNull();
    expect(refusal).toBe('already_on_roster');
  });

  it('refuses an unknown team role', () => {
    const { added, refusal } = extendMissionTeamPlanRoster(developmentPlan(), {
      teamRole: 'chief-vibes-officer',
    });
    expect(added).toBeNull();
    expect(refusal).toBe('unknown_team_role');
  });

  it('refuses past the lifecycle max_members cap', () => {
    const plan = developmentPlan();
    const capped = {
      ...plan,
      team_governance: plan.team_governance && {
        ...plan.team_governance,
        lifecycle: { ...plan.team_governance.lifecycle, max_members: plan.assignments.length },
      },
    };
    const { added, refusal } = extendMissionTeamPlanRoster(capped, { teamRole: 'researcher' });
    expect(added).toBeNull();
    expect(refusal).toBe('max_members_reached');
  });

  it('never falls back to an excluded actor', () => {
    const plan = developmentPlan();
    // Exclude every agent eligible for the role: composition would fall back
    // to an excluded actor rather than leave the role unstaffed; restaffing
    // must refuse instead.
    const probe = extendMissionTeamPlanRoster(plan, { teamRole: 'researcher' });
    expect(probe.added?.agent_id).toBeTruthy();
    const { added, refusal } = extendMissionTeamPlanRoster(plan, {
      teamRole: 'researcher',
      excludeAgentIds: ['sovereign-brain', 'control-plane-agent', 'reasoning-worker'],
    });
    expect(added).toBeNull();
    expect(refusal).toBe('no_compatible_actor');
  });

  it('refuses when no eligible actor holds a demanded capability', () => {
    const { added, refusal } = extendMissionTeamPlanRoster(developmentPlan(), {
      teamRole: 'researcher',
      requiredCapabilities: ['time-travel'],
    });
    expect(added).toBeNull();
    expect(refusal).toBe('no_compatible_actor');
  });
});

describe('role gap diagnosis (TC-07)', () => {
  const missionId = 'MSN-ROLE-GAP-001';
  const missionPath = pathResolver.missionDir(missionId, 'public');

  const withPersistedPlan = (run: () => void) => {
    try {
      withExecutionContext('mission_controller', () => {
        safeMkdir(missionPath, { recursive: true });
        writeMissionTeamPlan(
          missionPath,
          composeMissionTeamPlan({ missionId, missionType: 'development', tier: 'public' })
        );
        run();
      });
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  };

  it('reports a role the roster does not carry as restaffable', () => {
    withPersistedPlan(() => {
      const gap = diagnoseMissionTeamRoleGap({ missionId, teamRole: 'researcher' });
      expect(gap.kind).toBe('role_not_on_roster');
    });
  });

  it('reports no gap for a role the roster carries', () => {
    withPersistedPlan(() => {
      expect(diagnoseMissionTeamRoleGap({ missionId, teamRole: 'reviewer' }).kind).toBe('none');
    });
  });

  it('names the capabilities no eligible actor holds', () => {
    withPersistedPlan(() => {
      const gap = diagnoseMissionTeamRoleGap({
        missionId,
        teamRole: 'reviewer',
        requiredCapabilities: ['time-travel'],
      });
      expect(gap.kind).toBe('no_capable_actor');
      expect(gap.missing_capabilities).toEqual(['time-travel']);
      expect(gap.eligible_agent_ids.length).toBeGreaterThan(0);
    });
  });
});

describe('restaffed members survive recomposition (TC-06)', () => {
  it('keeps a restaffed role when the plan is refreshed', () => {
    const missionId = 'MSN-RESTAFF-REFRESH';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    try {
      withExecutionContext('mission_controller', () => {
        safeMkdir(missionPath, { recursive: true });
        const initial = composeMissionTeamPlan({
          missionId,
          missionType: 'development',
          tier: 'public',
        });
        const { plan: extended, added } = extendMissionTeamPlanRoster(initial, {
          teamRole: 'researcher',
        });
        expect(added).not.toBeNull();
        writeMissionTeamPlan(missionPath, extended);

        // Recomposition derives the roster from template + obligations, which
        // does not contain `researcher` — the recorded staffing decision must
        // not be silently dropped.
        const refreshed = resolveMissionTeamPlan({ missionId, forceRefresh: true });
        const researcher = refreshed.assignments.find((entry) => entry.team_role === 'researcher');
        expect(researcher?.status).toBe('assigned');
        expect(researcher?.agent_id).toBe(added?.agent_id);
        expect(researcher?.role_sources).toEqual(['restaff']);
        expect(refreshed.team_governance?.composition.assigned_roles).toContain('researcher');
      });
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });
});
