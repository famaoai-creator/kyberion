import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync } from './secure-io.js';
import { withExecutionContext, withExecutionContextAsync } from './authority.js';
import { composeMissionTeamPlan, writeMissionTeamPlan } from './mission-team-plan-composer.js';
import { buildMissionAdvisoryPanel, consultMissionAdvisors } from './mission-advisory-panel.js';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';

const missionId = 'MSN-ADVISORY-PANEL';
const missionPath = pathResolver.missionDir(missionId, 'public');

afterEach(() => resetReasoningBackend());

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

  it('does not send confidential context to an external backend', async () => {
    const confidentialMissionId = 'MSN-ADVISORY-CONFIDENTIAL';
    const confidentialMissionPath = pathResolver.missionDir(confidentialMissionId, 'confidential');
    const prompt = vi.fn(async () => 'should not be called');
    const externalBackend: ReasoningBackend = {
      ...stubReasoningBackend,
      name: 'claude-cli',
      prompt,
    };
    const dispose = registerReasoningBackend(externalBackend);
    try {
      withExecutionContext('mission_controller', () => {
        safeMkdir(confidentialMissionPath, { recursive: true });
        writeMissionTeamPlan(
          confidentialMissionPath,
          composeMissionTeamPlan({
            missionId: confidentialMissionId,
            missionType: 'development',
            tier: 'confidential',
            tenantSlug: 'tenant-a',
          })
        );
      });

      const consultation = await withExecutionContextAsync('mission_controller', () =>
        consultMissionAdvisors({
          missionId: confidentialMissionId,
          topic: 'confidential topic',
          question: 'confidential question',
          context: 'confidential context',
        })
      );
      expect(consultation.status).toBe('no_panel');
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      dispose();
      withExecutionContext('mission_controller', () => {
        safeRmSync(confidentialMissionPath, { recursive: true, force: true });
      });
    }
  });
});
