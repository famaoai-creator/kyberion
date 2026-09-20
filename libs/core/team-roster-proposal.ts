import { logger } from './core.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { loadTeamRoleIndex } from './mission-team-index.js';
import { loadMissionTeamPlan } from './mission-team-plan-composer.js';
import {
  appendMissionExecutionLedgerEntry,
  readMissionExecutionLedger,
  restaffMissionTeamRole,
} from './mission-team-binding.js';
import {
  resolveAlwaysStaffedRoles,
  resolveRosterProposalPolicy,
} from './team-composition-obligations.js';

/**
 * TC-12: let a model PROPOSE discretionary roles — never decide them.
 *
 * The roster is derived: template preference plus governed obligations
 * (TC-04), staffed on demand (TC-01). That covers what policy can anticipate.
 * It cannot cover the tail — a mission whose actual work wants a
 * `counterparty_persona` or a `devils_advocate` that no rule predicted. This
 * is the proposer for that tail, shaped like every other generative step in
 * this repository (`draft → preflight → commit`):
 *
 *  - it may only name roles from the governed team-role index, minus the
 *    structural roles and minus the policy's exclusions. A hallucinated role
 *    is dropped, not created;
 *  - each surviving proposal is committed through `restaffMissionTeamRole`,
 *    so capability, authority, scope-class, separation-of-duties and the
 *    `max_members` cap all apply exactly as they do to a human's restaff;
 *  - every proposal and its outcome goes to the mission execution ledger, so
 *    the acceptance rate is measurable (TC-13) rather than assumed;
 *  - it is OFF by default. The derived roster is the product's behaviour; the
 *    proposer is an opt-in that must earn its place against that baseline.
 */
export interface RosterProposal {
  team_role: string;
  rationale: string;
}

export interface RosterProposalDecision extends RosterProposal {
  accepted: boolean;
  agent_id?: string | null;
  refusal?: string;
}

export type RosterProposalStatus =
  | 'disabled'
  | 'mission_plan_not_found'
  | 'no_candidate_roles'
  | 'backend_unavailable'
  | 'invalid_response'
  | 'completed';

export interface RosterProposalOutcome {
  mission_id: string;
  status: RosterProposalStatus;
  /** Roles the proposer was allowed to choose from. */
  candidate_roles: string[];
  decisions: RosterProposalDecision[];
  accepted_roles: string[];
}

/**
 * The fail-closed boundary between a model's answer and a staffing decision.
 *
 * Exported because this is the security-relevant behaviour of the proposer:
 * anything that is not a role from the governed menu is dropped, including a
 * plausible-sounding invented one, and an unparseable answer yields `null`
 * (no proposals) rather than a guess.
 */
export function parseRosterProposals(
  raw: string,
  candidateRoles: Iterable<string>
): RosterProposal[] | null {
  const allowed = new Set(candidateRoles);
  return parseProposalsInternal(raw, allowed);
}

function parseProposalsInternal(raw: string, candidateRoles: Set<string>): RosterProposal[] | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const proposals: RosterProposal[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const teamRole = typeof record.team_role === 'string' ? record.team_role.trim() : '';
    // Fail-closed on anything outside the governed menu: a proposer may pick
    // from the team-role index, it may not invent a role.
    if (!candidateRoles.has(teamRole)) continue;
    if (proposals.some((proposal) => proposal.team_role === teamRole)) continue;
    proposals.push({
      team_role: teamRole,
      rationale:
        typeof record.rationale === 'string' && record.rationale.trim()
          ? record.rationale.trim().slice(0, 400)
          : 'No rationale given.',
    });
  }
  return proposals;
}

function buildPrompt(input: {
  missionId: string;
  missionContext: string;
  rosterRoles: string[];
  candidateRoles: Array<{ role: string; description: string }>;
  maxProposals: number;
}): string {
  return [
    'You are advising on the composition of an agent team for one mission.',
    '',
    `Mission: ${input.missionId}`,
    `Mission context: ${input.missionContext}`,
    '',
    `The team already covers these roles: ${input.rosterRoles.join(', ')}.`,
    '',
    'You may propose ADDITIONAL roles, only from this list:',
    ...input.candidateRoles.map((entry) => `- ${entry.role}: ${entry.description}`),
    '',
    `Propose at most ${input.maxProposals} roles, and only where the mission clearly needs`,
    'work the existing roles do not cover. Proposing nothing is the right answer when the',
    'team is already sufficient — an unnecessary member costs budget and attention.',
    '',
    'Answer with a JSON array and nothing else:',
    '[{"team_role": "<role from the list>", "rationale": "<one sentence>"}]',
    'Return [] to propose nothing.',
  ].join('\n');
}

export async function proposeMissionTeamRoster(input: {
  missionId: string;
  missionContext?: string;
  /** Override the governed policy switch (tests and explicit operator runs). */
  force?: boolean;
}): Promise<RosterProposalOutcome> {
  const missionId = input.missionId.toUpperCase();
  const policy = resolveRosterProposalPolicy();
  const base: RosterProposalOutcome = {
    mission_id: missionId,
    status: 'disabled',
    candidate_roles: [],
    decisions: [],
    accepted_roles: [],
  };
  if (!policy.enabled && !input.force) return base;

  const plan = loadMissionTeamPlan(missionId);
  if (!plan) return { ...base, status: 'mission_plan_not_found' };

  const onRoster = new Set(plan.assignments.map((assignment) => assignment.team_role));
  const structural = resolveAlwaysStaffedRoles();
  const excluded = new Set(policy.excluded_roles);
  const teamRoles = loadTeamRoleIndex();
  const candidates = Object.entries(teamRoles)
    .filter(([role]) => !onRoster.has(role) && !structural.has(role) && !excluded.has(role))
    .map(([role, record]) => ({ role, description: record.description }))
    .sort((left, right) => left.role.localeCompare(right.role));
  const candidateRoles = candidates.map((entry) => entry.role);
  if (candidates.length === 0) {
    return { ...base, status: 'no_candidate_roles', candidate_roles: candidateRoles };
  }

  const classification = plan.mission_classification;
  const missionContext =
    input.missionContext?.trim() ||
    [
      classification?.mission_class,
      classification?.delivery_shape,
      `risk ${classification?.risk_profile}`,
    ]
      .filter(Boolean)
      .join(' / ') ||
    plan.mission_type;

  const backend = getReasoningBackend();
  if (backend.name === 'stub') {
    // The stub backend answers deterministically for offline tests; treating
    // its answer as a staffing opinion would be a lie.
    return { ...base, status: 'backend_unavailable', candidate_roles: candidateRoles };
  }

  let raw: string;
  try {
    raw = await backend.prompt(
      buildPrompt({
        missionId,
        missionContext,
        rosterRoles: [...onRoster].sort(),
        candidateRoles: candidates,
        maxProposals: policy.max_proposals,
      })
    );
  } catch (error) {
    logger.warn(
      `[roster-proposal] ${missionId}: backend failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { ...base, status: 'backend_unavailable', candidate_roles: candidateRoles };
  }

  const proposals = parseRosterProposals(raw, candidateRoles);
  if (proposals === null) {
    return { ...base, status: 'invalid_response', candidate_roles: candidateRoles };
  }

  const decisions: RosterProposalDecision[] = [];
  for (const proposal of proposals.slice(0, policy.max_proposals)) {
    const restaffed = restaffMissionTeamRole({
      missionId,
      teamRole: proposal.team_role,
      requestedBy: 'team_roster_proposer',
      reason: `Proposed by the roster proposer: ${proposal.rationale}`,
    });
    decisions.push({
      ...proposal,
      accepted: Boolean(restaffed.added),
      agent_id: restaffed.added?.agent_id ?? null,
      ...(restaffed.added ? {} : { refusal: restaffed.refusal || 'not_added' }),
    });
  }

  // TC-13: the ledger is the measurement surface — acceptance rate comes from
  // recorded outcomes, not from trusting the proposer.
  appendMissionExecutionLedgerEntry({
    mission_id: missionId,
    event_type: 'team_roster_proposed',
    decision: `${decisions.filter((entry) => entry.accepted).length}/${decisions.length} proposals accepted`,
    payload: {
      candidate_roles: candidateRoles,
      backend: backend.name,
      decisions,
    },
  });

  return {
    mission_id: missionId,
    status: 'completed',
    candidate_roles: candidateRoles,
    decisions,
    accepted_roles: decisions.filter((entry) => entry.accepted).map((entry) => entry.team_role),
  };
}

/**
 * TC-13: measure the proposer against the baseline it has to beat.
 *
 * Acceptance rate alone flatters a proposer that suggests only safe, obvious
 * roles. The number that matters is `follow_up_restaff_rate`: roles someone
 * else had to add after the proposer ran. A proposer that anticipates nothing
 * leaves that high, and the honest response is to leave the feature off —
 * which is why the policy default is `enabled: false` and this summary reads
 * recorded outcomes rather than the proposer's own claims.
 */
export interface RosterProposalOutcomeSummary {
  mission_id: string;
  proposal_runs: number;
  proposals_total: number;
  accepted: number;
  rejected: number;
  acceptance_rate: number;
  refusals: Record<string, number>;
  /** Roles restaffed by someone else after the last proposal run. */
  follow_up_restaffed_roles: string[];
  follow_up_restaff_rate: number;
}

export function summarizeRosterProposalOutcomes(
  missionId: string,
  missionPathHint?: string
): RosterProposalOutcomeSummary {
  const entries = readMissionExecutionLedger(missionId, missionPathHint);
  const proposalEntries = entries.filter((entry) => entry.event_type === 'team_roster_proposed');
  const decisions = proposalEntries.flatMap((entry) => {
    const payload = entry.payload as { decisions?: RosterProposalDecision[] } | undefined;
    return Array.isArray(payload?.decisions) ? payload.decisions : [];
  });
  const accepted = decisions.filter((decision) => decision.accepted).length;
  const refusals: Record<string, number> = {};
  for (const decision of decisions) {
    if (decision.accepted) continue;
    const key = decision.refusal || 'not_added';
    refusals[key] = (refusals[key] || 0) + 1;
  }

  const lastProposalAt = proposalEntries.at(-1)?.ts;
  const followUp = entries.filter(
    (entry) =>
      entry.event_type === 'team_role_restaffed' &&
      (entry.payload as { requested_by?: string } | undefined)?.requested_by !==
        'team_roster_proposer' &&
      (!lastProposalAt || entry.ts > lastProposalAt)
  );
  const followUpRoles = [...new Set(followUp.map((entry) => entry.team_role || ''))]
    .filter(Boolean)
    .sort();

  const totalRosterAdditions = accepted + followUpRoles.length;
  return {
    mission_id: missionId.toUpperCase(),
    proposal_runs: proposalEntries.length,
    proposals_total: decisions.length,
    accepted,
    rejected: decisions.length - accepted,
    acceptance_rate: decisions.length === 0 ? 0 : accepted / decisions.length,
    refusals,
    follow_up_restaffed_roles: followUpRoles,
    follow_up_restaff_rate:
      totalRosterAdditions === 0 ? 0 : followUpRoles.length / totalRosterAdditions,
  };
}
