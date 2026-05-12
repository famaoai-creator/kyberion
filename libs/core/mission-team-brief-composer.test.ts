import { describe, expect, it } from 'vitest';
import { composeMissionTeamBrief } from './mission-team-brief-composer.js';

describe('mission-team-brief-composer request briefing', () => {
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
    expect(brief.team_governance?.lifecycle.max_members).toBeGreaterThan(0);
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
