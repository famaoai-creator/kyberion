import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import { appendMissionExecutionLedgerEntry } from './mission-team-binding.js';
import {
  collectMissionDecisionSupportMetrics,
  formatTeamDecisionSupportReport,
  buildTeamDecisionSupportReport,
} from './team-decision-support-metrics.js';

const missionId = 'MSN-DECISION-SUPPORT-METRICS';
const missionPath = pathResolver.missionDir(missionId, 'public');

function withLedger(entries: Array<Parameters<typeof appendMissionExecutionLedgerEntry>[0]>) {
  return withExecutionContext('mission_controller', () => {
    safeMkdir(missionPath, { recursive: true });
    for (const entry of entries) appendMissionExecutionLedgerEntry(entry);
    return collectMissionDecisionSupportMetrics({ missionId, missionPath });
  });
}

function cleanup() {
  withExecutionContext('mission_controller', () => {
    safeRmSync(missionPath, { recursive: true, force: true });
  });
}

describe('team decision support metrics (TC-19)', () => {
  it('counts proposals, acceptances and refusal reasons from the ledger', () => {
    try {
      const metrics = withLedger([
        {
          mission_id: missionId,
          mission_path_hint: missionPath,
          event_type: 'team_roster_proposed',
          payload: {
            decisions: [
              { team_role: 'researcher', rationale: 'r', accepted: true },
              {
                team_role: 'scribe',
                rationale: 's',
                accepted: false,
                refusal: 'max_members_reached',
              },
              {
                team_role: 'tracker',
                rationale: 't',
                accepted: false,
                refusal: 'max_members_reached',
              },
            ],
          },
        },
      ]);
      expect(metrics.proposal_runs).toBe(1);
      expect(metrics.proposals_total).toBe(3);
      expect(metrics.proposals_accepted).toBe(1);
      expect(metrics.refusals).toEqual({ max_members_reached: 2 });
    } finally {
      cleanup();
    }
  });

  it('counts a role added after the proposer ran as a miss, and its own additions as not', () => {
    try {
      const metrics = withLedger([
        {
          mission_id: missionId,
          mission_path_hint: missionPath,
          event_type: 'team_role_restaffed',
          team_role: 'operator',
          payload: { requested_by: 'mission_controller' },
        },
        {
          mission_id: missionId,
          mission_path_hint: missionPath,
          event_type: 'team_roster_proposed',
          payload: { decisions: [{ team_role: 'researcher', rationale: 'r', accepted: true }] },
        },
        {
          mission_id: missionId,
          mission_path_hint: missionPath,
          event_type: 'team_role_restaffed',
          team_role: 'researcher',
          payload: { requested_by: 'team_roster_proposer' },
        },
        {
          mission_id: missionId,
          mission_path_hint: missionPath,
          event_type: 'team_role_restaffed',
          team_role: 'tester',
          payload: { requested_by: 'mission_orchestration_worker' },
        },
      ]);
      // `operator` came before the run and cannot be held against it; the
      // proposer's own addition is not a miss; `tester` is.
      expect(metrics.follow_up_restaffed_roles).toEqual(['tester']);
    } finally {
      cleanup();
    }
  });

  it('counts advisory opinions and how many survived the panel critique', () => {
    try {
      const metrics = withLedger([
        {
          mission_id: missionId,
          mission_path_hint: missionPath,
          event_type: 'advisory_consultation',
          payload: {
            opinions: [
              { team_role: 'owner', survived: true },
              { team_role: 'reviewer', survived: false },
              { team_role: 'devils_advocate', survived: true },
            ],
          },
        },
      ]);
      expect(metrics.advisory_consultations).toBe(1);
      expect(metrics.advisory_opinions).toBe(3);
      expect(metrics.advisory_opinions_survived).toBe(2);
      expect(metrics.advisory_roles).toEqual(['devils_advocate', 'owner', 'reviewer']);
    } finally {
      cleanup();
    }
  });

  it('reports zeroes rather than dividing by zero for a quiet mission', () => {
    const report = buildTeamDecisionSupportReport({ directories: ['active/missions/nonexistent'] });
    expect(report.missions_with_activity).toBe(0);
    expect(report.acceptance_rate).toBe(0);
    expect(report.follow_up_restaff_rate).toBe(0);
    expect(report.opinion_survival_rate).toBe(0);
    expect(formatTeamDecisionSupportReport(report)).toContain('roster proposer');
  });
});
