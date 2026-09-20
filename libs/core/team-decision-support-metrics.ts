import { nowIso } from './foundation/time.js';
import { listMissionsInSearchDirs } from './mission-state.js';
import { readMissionExecutionLedger } from './mission-team-binding.js';
import type { RosterProposalDecision } from './team-roster-proposal.js';

/**
 * TC-19: measure the two decision-support features against the baseline they
 * have to beat, across missions rather than one at a time.
 *
 * The roster proposer (TC-12) and the advisory panel (TC-18) both add model
 * calls to a path that already worked without them. Per-mission summaries
 * answer "what happened here"; they cannot answer "is this worth keeping on".
 * That needs the cross-mission view, and it needs the unflattering numbers:
 *
 *  - `follow_up_restaff_rate` — roles someone else had to add after the
 *    proposer ran. A proposer that suggests only safe, obvious roles scores a
 *    fine acceptance rate and leaves this high.
 *  - `opinion_survival_rate` — opinions that survived the panel's own
 *    critique. A panel where everything survives is not deliberating, and one
 *    where nothing does is not advising.
 *
 * Everything here is read from recorded ledger entries. Nothing is taken from
 * the proposer's or the panel's own account of how it did.
 */
export interface MissionDecisionSupportMetrics {
  mission_id: string;
  proposal_runs: number;
  proposals_total: number;
  proposals_accepted: number;
  refusals: Record<string, number>;
  follow_up_restaffed_roles: string[];
  advisory_consultations: number;
  advisory_opinions: number;
  advisory_opinions_survived: number;
  advisory_roles: string[];
}

export interface TeamDecisionSupportReport {
  generated_at: string;
  missions_scanned: number;
  missions_with_activity: number;
  proposal_runs: number;
  proposals_total: number;
  proposals_accepted: number;
  /** Accepted / proposed. High alone means little — read it with the next one. */
  acceptance_rate: number;
  follow_up_restaffed_roles: string[];
  /** Roles added by someone other than the proposer, over all roster additions. */
  follow_up_restaff_rate: number;
  refusals: Record<string, number>;
  advisory_consultations: number;
  advisory_opinions: number;
  advisory_opinions_survived: number;
  /** Opinions surviving the panel's own critique. */
  opinion_survival_rate: number;
  advisory_role_participation: Record<string, number>;
  per_mission: MissionDecisionSupportMetrics[];
}

function emptyMissionMetrics(missionId: string): MissionDecisionSupportMetrics {
  return {
    mission_id: missionId,
    proposal_runs: 0,
    proposals_total: 0,
    proposals_accepted: 0,
    refusals: {},
    follow_up_restaffed_roles: [],
    advisory_consultations: 0,
    advisory_opinions: 0,
    advisory_opinions_survived: 0,
    advisory_roles: [],
  };
}

export function collectMissionDecisionSupportMetrics(input: {
  missionId: string;
  missionPath?: string;
}): MissionDecisionSupportMetrics {
  const metrics = emptyMissionMetrics(input.missionId);
  const entries = readMissionExecutionLedger(input.missionId, input.missionPath);
  let lastProposalAt: string | undefined;

  for (const entry of entries) {
    if (entry.event_type === 'team_roster_proposed') {
      metrics.proposal_runs += 1;
      lastProposalAt = entry.ts;
      const decisions = (entry.payload as { decisions?: RosterProposalDecision[] } | undefined)
        ?.decisions;
      for (const decision of Array.isArray(decisions) ? decisions : []) {
        metrics.proposals_total += 1;
        if (decision.accepted) {
          metrics.proposals_accepted += 1;
          continue;
        }
        const reason = decision.refusal || 'not_added';
        metrics.refusals[reason] = (metrics.refusals[reason] || 0) + 1;
      }
      continue;
    }
    if (entry.event_type === 'advisory_consultation') {
      metrics.advisory_consultations += 1;
      const opinions = (
        entry.payload as
          { opinions?: Array<{ team_role?: string; survived?: boolean }> } | undefined
      )?.opinions;
      for (const opinion of Array.isArray(opinions) ? opinions : []) {
        metrics.advisory_opinions += 1;
        if (opinion.survived) metrics.advisory_opinions_survived += 1;
        if (opinion.team_role && !metrics.advisory_roles.includes(opinion.team_role)) {
          metrics.advisory_roles.push(opinion.team_role);
        }
      }
    }
  }

  // A role added after the last proposal run, by anyone other than the
  // proposer, is a role the proposer failed to anticipate.
  for (const entry of entries) {
    if (entry.event_type !== 'team_role_restaffed') continue;
    if (
      (entry.payload as { requested_by?: string } | undefined)?.requested_by ===
      'team_roster_proposer'
    ) {
      continue;
    }
    if (lastProposalAt && entry.ts <= lastProposalAt) continue;
    const role = entry.team_role;
    if (role && !metrics.follow_up_restaffed_roles.includes(role)) {
      metrics.follow_up_restaffed_roles.push(role);
    }
  }
  metrics.follow_up_restaffed_roles.sort();
  metrics.advisory_roles.sort();
  return metrics;
}

export function buildTeamDecisionSupportReport(
  options: { rootDir?: string; directories?: string[] } = {}
): TeamDecisionSupportReport {
  const missions = listMissionsInSearchDirs(options);
  const perMission: MissionDecisionSupportMetrics[] = [];
  for (const mission of missions) {
    const metrics = collectMissionDecisionSupportMetrics({
      missionId: mission.missionId,
      missionPath: mission.missionPath,
    });
    if (
      metrics.proposal_runs === 0 &&
      metrics.advisory_consultations === 0 &&
      metrics.follow_up_restaffed_roles.length === 0
    ) {
      continue;
    }
    perMission.push(metrics);
  }

  const sum = (pick: (metrics: MissionDecisionSupportMetrics) => number): number =>
    perMission.reduce((total, metrics) => total + pick(metrics), 0);

  const refusals: Record<string, number> = {};
  const advisoryRoleParticipation: Record<string, number> = {};
  const followUpRoles = new Set<string>();
  for (const metrics of perMission) {
    for (const [reason, count] of Object.entries(metrics.refusals)) {
      refusals[reason] = (refusals[reason] || 0) + count;
    }
    for (const role of metrics.advisory_roles) {
      advisoryRoleParticipation[role] = (advisoryRoleParticipation[role] || 0) + 1;
    }
    for (const role of metrics.follow_up_restaffed_roles) followUpRoles.add(role);
  }

  const proposalsTotal = sum((metrics) => metrics.proposals_total);
  const proposalsAccepted = sum((metrics) => metrics.proposals_accepted);
  const advisoryOpinions = sum((metrics) => metrics.advisory_opinions);
  const advisorySurvived = sum((metrics) => metrics.advisory_opinions_survived);
  const followUpCount = sum((metrics) => metrics.follow_up_restaffed_roles.length);
  const rosterAdditions = proposalsAccepted + followUpCount;

  return {
    generated_at: nowIso(),
    missions_scanned: missions.length,
    missions_with_activity: perMission.length,
    proposal_runs: sum((metrics) => metrics.proposal_runs),
    proposals_total: proposalsTotal,
    proposals_accepted: proposalsAccepted,
    acceptance_rate: proposalsTotal === 0 ? 0 : proposalsAccepted / proposalsTotal,
    follow_up_restaffed_roles: [...followUpRoles].sort(),
    follow_up_restaff_rate: rosterAdditions === 0 ? 0 : followUpCount / rosterAdditions,
    refusals,
    advisory_consultations: sum((metrics) => metrics.advisory_consultations),
    advisory_opinions: advisoryOpinions,
    advisory_opinions_survived: advisorySurvived,
    opinion_survival_rate: advisoryOpinions === 0 ? 0 : advisorySurvived / advisoryOpinions,
    advisory_role_participation: advisoryRoleParticipation,
    per_mission: perMission.sort((left, right) => left.mission_id.localeCompare(right.mission_id)),
  };
}

export function formatTeamDecisionSupportReport(report: TeamDecisionSupportReport): string {
  const lines: string[] = [];
  lines.push(
    `missions scanned=${report.missions_scanned} with decision-support activity=${report.missions_with_activity}`
  );
  lines.push('');
  lines.push('roster proposer');
  lines.push(
    `  runs=${report.proposal_runs} proposed=${report.proposals_total} accepted=${report.proposals_accepted} ` +
      `acceptance_rate=${report.acceptance_rate.toFixed(2)}`
  );
  lines.push(
    `  follow_up_restaff_rate=${report.follow_up_restaff_rate.toFixed(2)}` +
      (report.follow_up_restaffed_roles.length > 0
        ? ` (${report.follow_up_restaffed_roles.join(', ')})`
        : '') +
      '   <- roles someone else had to add after it ran'
  );
  if (Object.keys(report.refusals).length > 0) {
    const refusals = Object.entries(report.refusals)
      .sort(([, left], [, right]) => right - left)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(' ');
    lines.push(`  refusals: ${refusals}`);
  }
  lines.push('');
  lines.push('advisory panel');
  lines.push(
    `  consultations=${report.advisory_consultations} opinions=${report.advisory_opinions} ` +
      `survived=${report.advisory_opinions_survived} survival_rate=${report.opinion_survival_rate.toFixed(2)}`
  );
  const participation = Object.entries(report.advisory_role_participation)
    .sort(([, left], [, right]) => right - left)
    .map(([role, count]) => `${role}=${count}`)
    .join(' ');
  if (participation) lines.push(`  role participation: ${participation}`);
  if (report.per_mission.length > 0) {
    lines.push('');
    lines.push('per mission');
    for (const metrics of report.per_mission) {
      lines.push(
        `  ${metrics.mission_id.padEnd(34)} runs=${metrics.proposal_runs} ` +
          `proposals=${metrics.proposals_accepted}/${metrics.proposals_total} ` +
          `advisory=${metrics.advisory_opinions_survived}/${metrics.advisory_opinions} ` +
          `follow_up=${metrics.follow_up_restaffed_roles.length}`
      );
    }
  }
  return lines.join('\n');
}
