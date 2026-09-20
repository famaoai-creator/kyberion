import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import { composeMissionTeamPlan, writeMissionTeamPlan } from './mission-team-plan-composer.js';
import { buildMissionAdvisoryPanel, consultMissionAdvisors } from './mission-advisory-panel.js';

const missionId = 'MSN-ADVISORY-PANEL';
const missionPath = pathResolver.missionDir(missionId, 'public');

function withPlan<T>(run: () => T): T {
  try {
    return withExecutionContext('mission_controller', () => {
      safeMkdir(missionPath, { recursive: true });
      writeMissionTeamPlan(
        missionPath,
        composeMissionTeamPlan({ missionId, missionType: 'development', tier: 'public' })
      );
      return run();
    });
  } finally {
    withExecutionContext('mission_controller', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
    });
  }
}

describe('mission advisory panel (TC-18)', () => {
  it('builds the panel from the roster, not from hand-written labels', () => {
    withPlan(() => {
      const panel = buildMissionAdvisoryPanel(missionId);
      expect(panel.length).toBeGreaterThan(3);
      for (const advisor of panel) {
        // Every advisor carries the identity team composition already resolved:
        // participant id, perspectives and its real security scope.
        expect(advisor.participant.participant_id).toBe(`${advisor.agent_id}:${advisor.team_role}`);
        expect(advisor.participant.team_role_id).toBe(advisor.team_role);
        expect(advisor.participant.perspective_ids.length).toBeGreaterThan(0);
        expect(advisor.participant.security_scope.mission_id).toBe(missionId);
      }
    });
  });

  it('includes standby members, who can advise without being staffed', () => {
    withPlan(() => {
      const all = buildMissionAdvisoryPanel(missionId);
      const staffedOnly = buildMissionAdvisoryPanel(missionId, { includeStandby: false });
      expect(all.some((advisor) => advisor.staffing_state === 'standby')).toBe(true);
      expect(staffedOnly.every((advisor) => advisor.staffing_state === 'assigned')).toBe(true);
      expect(staffedOnly.length).toBeLessThan(all.length);
    });
  });

  it('narrows to the asked roles and leaves out the asker', () => {
    withPlan(() => {
      const panel = buildMissionAdvisoryPanel(missionId, {
        roles: ['owner', 'reviewer', 'implementer'],
        excludeRoles: ['implementer'],
      });
      expect(panel.map((advisor) => advisor.team_role).sort()).toEqual(['owner', 'reviewer']);
    });
  });

  it('caps the panel size', () => {
    withPlan(() => {
      expect(buildMissionAdvisoryPanel(missionId, { maxAdvisors: 2 })).toHaveLength(2);
    });
  });

  it('returns an empty panel for a mission with no plan', () => {
    expect(buildMissionAdvisoryPanel('MSN-NO-SUCH-MISSION')).toEqual([]);
  });

  it('reports a missing plan rather than consulting nobody silently', async () => {
    const consultation = await consultMissionAdvisors({
      missionId: 'MSN-NO-SUCH-MISSION',
      topic: 't',
      question: 'q',
    });
    expect(consultation.status).toBe('mission_plan_not_found');
    expect(consultation.opinions).toEqual([]);
  });
});
