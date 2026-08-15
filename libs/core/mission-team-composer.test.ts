import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync } from './secure-io.js';
import {
  composeMissionTeamPlan,
  resolveMissionTeamReceiver,
  resolveMissionTeamPlan,
  writeMissionTeamPlan,
} from './mission-team-plan-composer.js';
import { discoverProviders } from './provider-discovery.js';

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
    expect(researcher?.status).toBe('assigned');
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
    expect(plan.team_governance?.composition.optional_roles).toContain('surface_liaison');
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
      ).toEqual(expect.objectContaining({ provider: 'agy' }));
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

      const selected = resolveMissionTeamReceiver({
        missionId,
        teamRole: 'reviewer',
        excludedAgentIds: [implementationAgentId],
        requiredCapabilities: ['review', 'documentation', 'analysis'],
      });

      expect(selected?.agent_id).toBe('reasoning-worker');
      expect(selected?.agent_id).not.toBe(implementationAgentId);
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
});
