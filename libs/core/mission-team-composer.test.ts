import { describe, expect, it } from 'vitest';
import { composeMissionTeamBrief, composeMissionTeamPlan } from './mission-team-composer.js';

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
    expect(owner?.delegation_contract?.ownership_scope).toContain('end-to-end mission objective');
    expect(owner?.delegation_contract?.allowed_delegate_team_roles).toContain('planner');
    expect(owner?.delegation_contract?.resolved_scope_classes).toContain('mission_state');
    expect(owner?.delegation_contract?.allowed_write_scopes.length).toBeGreaterThan(0);
  });
});

describe('mission-team-composer request briefing', () => {
  it('builds a composition brief from user request text', () => {
    const brief = composeMissionTeamBrief({
      missionId: 'MSN-BRIEF-001',
      request: 'design and implement onboarding UX, then deploy and report in Slack',
      tier: 'public',
      executionShape: 'mission',
    });

    expect(brief.mission_id).toBe('MSN-BRIEF-001');
    expect(brief.workflow_design.workflow_id).toBeTruthy();
    expect(brief.review_design.review_mode).toBeTruthy();
    expect(brief.team_plan.assignments.length).toBeGreaterThan(0);
    expect(brief.recommended_optional_roles).toContain('experience_designer');
    expect(brief.recommended_optional_roles).not.toContain('operator');
    expect(brief.recommended_optional_roles).not.toContain('surface_liaison');
    const teamRoles = brief.team_plan.assignments.map((entry) => entry.team_role);
    expect(teamRoles).toContain('operator');
    expect(teamRoles).toContain('surface_liaison');
    expect(brief.missing_inputs).toEqual([]);
  });

  it('flags missing references for contextual shorthand and personal voice requests', () => {
    const brief = composeMissionTeamBrief({
      missionId: 'MSN-BRIEF-002',
      request: '前と同じ感じで私の声を使って紹介動画を作って',
      tier: 'confidential',
      executionShape: 'mission',
    });

    expect(brief.missing_inputs).toContain('reference_context');
    expect(brief.missing_inputs).toContain('voice_profile_id');
  });
});
