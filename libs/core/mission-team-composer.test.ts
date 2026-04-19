import { describe, expect, it } from 'vitest';
import { composeMissionTeamPlan } from './mission-team-composer.js';

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
