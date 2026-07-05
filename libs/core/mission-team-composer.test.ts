import { describe, expect, it } from 'vitest';
import { composeMissionTeamPlan } from './mission-team-plan-composer.js';

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
    expect(plan.mission_classification?.mission_class).toBe('product_delivery');
    expect(plan.mission_classification?.stage).toBe('classification');

    const owner = plan.assignments.find((assignment) => assignment.team_role === 'owner');
    expect(owner?.status).toBe('assigned');
    expect(owner?.model_hint).toEqual(
      expect.objectContaining({
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
      })
    );
    expect(owner?.delegation_contract?.ownership_scope).toContain('end-to-end mission objective');
    expect(owner?.delegation_contract?.allowed_delegate_team_roles).toContain('planner');
    expect(owner?.delegation_contract?.resolved_scope_classes).toContain('mission_state');
    expect(owner?.delegation_contract?.allowed_write_scopes.length).toBeGreaterThan(0);
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
});
