import { describe, expect, it } from 'vitest';
import { composeMissionTeamPlan } from './mission-team-plan-composer.js';
import { formatMissionTeamPlanView } from './mission-team-view.js';

const plan = composeMissionTeamPlan({
  missionId: 'MSN-TEAM-VIEW',
  missionType: 'development',
  tier: 'public',
});
const view = formatMissionTeamPlanView(plan);

describe('mission team view (TC-05)', () => {
  it('separates roster, staffed, standby and unfilled', () => {
    const staffed = plan.assignments.filter((entry) => entry.status === 'assigned').length;
    const standby = plan.assignments.filter((entry) => entry.status === 'standby').length;
    expect(view).toContain(
      `roster=${plan.assignments.length}/${plan.team_governance?.lifecycle.max_members}`
    );
    expect(view).toContain(`staffed=${staffed}`);
    expect(view).toContain(`standby=${standby}`);
    expect(view).toContain('unfilled=0');
  });

  it('shows why each role is on the roster', () => {
    // TC-04 recorded this; it was only readable by grepping the plan JSON.
    expect(view).toContain('structural+template');
    expect(view).toContain('obligation+template');
  });

  it('reads out the obligations with their reasons', () => {
    for (const obligation of plan.team_governance?.obligations || []) {
      expect(view).toContain(obligation.id);
      expect(view).toContain(obligation.reason);
    }
  });

  it('lists every roster member with its actor', () => {
    for (const assignment of plan.assignments) {
      expect(view).toContain(assignment.team_role);
      if (assignment.agent_id) expect(view).toContain(assignment.agent_id);
    }
  });

  it('says standby is not a gap', () => {
    expect(view).toContain('gaps: none');
    expect(view).toContain('staffed when work demands them');
  });

  it('names the required roles the pool cannot fill', () => {
    const gapped = {
      ...plan,
      assignments: plan.assignments.map((entry) =>
        entry.team_role === 'reviewer'
          ? { ...entry, status: 'unfilled' as const, agent_id: null }
          : entry
      ),
      team_governance: plan.team_governance && {
        ...plan.team_governance,
        composition: {
          ...plan.team_governance.composition,
          unfilled_required_roles: ['reviewer'],
        },
      },
    };
    const gappedView = formatMissionTeamPlanView(gapped);
    expect(gappedView).toContain('UNFILLED');
    expect(gappedView).toContain('no compatible actor for required role(s) reviewer');
  });
});
