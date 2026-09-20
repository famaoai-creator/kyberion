import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import { appendMissionExecutionLedgerEntry } from './mission-team-binding.js';
import {
  parseRosterProposals,
  proposeMissionTeamRoster,
  summarizeRosterProposalOutcomes,
} from './team-roster-proposal.js';
import { resolveRosterProposalPolicy } from './team-composition-obligations.js';

describe('roster proposer (TC-12)', () => {
  it('is off by default', () => {
    // The derived roster is the product's behaviour; the proposer is an
    // opt-in that has to earn its place against that baseline.
    expect(resolveRosterProposalPolicy().enabled).toBe(false);
  });

  it('does nothing — and calls no backend — while disabled', async () => {
    const outcome = await proposeMissionTeamRoster({ missionId: 'MSN-NOT-REAL' });
    expect(outcome.status).toBe('disabled');
    expect(outcome.decisions).toEqual([]);
  });

  it('keeps only roles from the governed menu', () => {
    const parsed = parseRosterProposals(
      JSON.stringify([
        { team_role: 'researcher', rationale: 'needs background work' },
        { team_role: 'chief-vibes-officer', rationale: 'sounds useful' },
        { team_role: 'researcher', rationale: 'duplicate' },
      ]),
      ['researcher', 'tester']
    );
    expect(parsed).toEqual([{ team_role: 'researcher', rationale: 'needs background work' }]);
  });

  it('reads a fenced answer and an empty proposal', () => {
    expect(parseRosterProposals('```json\n[]\n```', ['researcher'])).toEqual([]);
    expect(
      parseRosterProposals('Sure! [{"team_role":"tester","rationale":"verify"}]', ['tester'])
    ).toEqual([{ team_role: 'tester', rationale: 'verify' }]);
  });

  it('returns null rather than guessing when the answer is not a proposal list', () => {
    expect(parseRosterProposals('I cannot help with that.', ['researcher'])).toBeNull();
    expect(parseRosterProposals('[{"team_role":]', ['researcher'])).toBeNull();
  });

  it('supplies a rationale placeholder instead of dropping a valid role', () => {
    expect(parseRosterProposals('[{"team_role":"tester"}]', ['tester'])).toEqual([
      { team_role: 'tester', rationale: 'No rationale given.' },
    ]);
  });
});

describe('roster proposal outcomes (TC-13)', () => {
  const missionId = 'MSN-PROPOSAL-SUMMARY';
  const missionPath = pathResolver.missionDir(missionId, 'public');

  it('measures acceptance and follow-up restaffing from recorded outcomes', () => {
    try {
      withExecutionContext('mission_controller', () => {
        safeMkdir(missionPath, { recursive: true });
        appendMissionExecutionLedgerEntry({
          mission_id: missionId,
          mission_path_hint: missionPath,
          event_type: 'team_roster_proposed',
          decision: '1/2 proposals accepted',
          payload: {
            decisions: [
              { team_role: 'researcher', rationale: 'r', accepted: true },
              {
                team_role: 'tester',
                rationale: 't',
                accepted: false,
                refusal: 'already_on_roster',
              },
            ],
          },
        });
        appendMissionExecutionLedgerEntry({
          mission_id: missionId,
          mission_path_hint: missionPath,
          event_type: 'team_role_restaffed',
          team_role: 'operator',
          payload: { requested_by: 'mission_orchestration_worker' },
        });

        const summary = summarizeRosterProposalOutcomes(missionId, missionPath);
        expect(summary.proposal_runs).toBe(1);
        expect(summary.accepted).toBe(1);
        expect(summary.rejected).toBe(1);
        expect(summary.acceptance_rate).toBe(0.5);
        expect(summary.refusals).toEqual({ already_on_roster: 1 });
        // The number that matters: a role someone else had to add after the
        // proposer ran is a role the proposer failed to anticipate.
        expect(summary.follow_up_restaffed_roles).toEqual(['operator']);
        expect(summary.follow_up_restaff_rate).toBe(0.5);
      });
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });

  it('reports zeroes for a mission with no proposals', () => {
    const summary = summarizeRosterProposalOutcomes('MSN-NO-PROPOSALS');
    expect(summary.proposal_runs).toBe(0);
    expect(summary.acceptance_rate).toBe(0);
    expect(summary.follow_up_restaff_rate).toBe(0);
  });
});
