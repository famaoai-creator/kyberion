import { logger } from './core.js';
import { validateReasoningEgress } from './context-security-scope.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { loadMissionTeamPlan } from './mission-team-plan-composer.js';
import { appendMissionExecutionLedgerEntry } from './mission-team-binding.js';
import { withReasoningPayloadScope } from './reasoning-egress-scope.js';
import type { ReasoningParticipant } from './reasoning-participant.js';
import type { MissionTeamAssignment } from './team-role-assignment-selection.js';

/**
 * TC-18: let a mission consult its own team.
 *
 * The advisory primitives already existed — perspective fanout, typed cross
 * critique, dissent logs — but they take hand-authored participants, so an
 * advisory conversation ran among labels a pipeline author invented rather
 * than among the agents actually staffed on the mission. Meanwhile team
 * composition already resolves exactly what those primitives need
 * (`participant_id`, `perspective_ids`, `reasoning_route_id`,
 * `security_scope`) for every roster member and then never uses it for
 * anything but the plan file.
 *
 * This is the missing projection: the roster IS the panel. Because the
 * participants carry their real security scope, an advisor that cannot read
 * the mission's tier is refused rather than quietly answering anyway.
 */
export interface MissionAdvisor {
  participant: ReasoningParticipant;
  team_role: string;
  agent_id: string;
  provider: string | null;
  model_id: string | null;
  /** Whether this advisor is currently staffed or waiting on standby. */
  staffing_state: 'assigned' | 'standby';
}

export interface BuildMissionAdvisoryPanelOptions {
  /** Restrict the panel to these roles (default: the whole roster). */
  roles?: string[];
  /** Roles to leave out — typically the asker's own role. */
  excludeRoles?: string[];
  /** Standby members may advise without being staffed; set false to require staffing. */
  includeStandby?: boolean;
  maxAdvisors?: number;
}

function toParticipant(assignment: MissionTeamAssignment): ReasoningParticipant | null {
  if (!assignment.agent_id || !assignment.authority_role || !assignment.security_scope) return null;
  return {
    participant_id: `${assignment.agent_id}:${assignment.team_role}`,
    ...(assignment.organization_role_id
      ? { organization_role_id: assignment.organization_role_id }
      : {}),
    team_role_id: assignment.team_role,
    perspective_ids: assignment.perspective_ids || [assignment.team_role],
    agent_profile_id: assignment.agent_id,
    authority_role_id: assignment.authority_role,
    reasoning_route_id: assignment.reasoning_route_id || 'default',
    security_scope: assignment.security_scope,
  };
}

export function buildMissionAdvisoryPanel(
  missionId: string,
  options: BuildMissionAdvisoryPanelOptions = {}
): MissionAdvisor[] {
  const plan = loadMissionTeamPlan(missionId.toUpperCase());
  if (!plan) return [];
  const includeStandby = options.includeStandby !== false;
  const allowedRoles = options.roles ? new Set(options.roles) : null;
  const excludedRoles = new Set(options.excludeRoles || []);
  const missionTier = plan.tier as 'personal' | 'confidential' | 'public';

  const advisors: MissionAdvisor[] = [];
  for (const assignment of plan.assignments) {
    if (assignment.status === 'unfilled') continue;
    if (assignment.status === 'standby' && !includeStandby) continue;
    if (allowedRoles && !allowedRoles.has(assignment.team_role)) continue;
    if (excludedRoles.has(assignment.team_role)) continue;
    const participant = toParticipant(assignment);
    if (!participant) continue;
    // A panel member who cannot read the mission's tier must not be asked
    // about its contents — the same rule typed cross-critique enforces.
    if (!participant.security_scope.read_tiers.includes(missionTier)) continue;
    advisors.push({
      participant,
      team_role: assignment.team_role,
      agent_id: assignment.agent_id!,
      provider: assignment.provider,
      model_id: assignment.modelId,
      staffing_state: assignment.status,
    });
  }
  return typeof options.maxAdvisors === 'number'
    ? advisors.slice(0, Math.max(0, options.maxAdvisors))
    : advisors;
}

export interface AdvisoryOpinion {
  team_role: string;
  agent_id: string;
  participant_id: string;
  perspective_ids: string[];
  opinion: string;
  /** Set when this advisor's opinion did not survive cross-critique. */
  rejection_reason?: string;
  survived: boolean;
}

export interface MissionAdvisoryConsultation {
  mission_id: string;
  topic: string;
  status: 'completed' | 'no_panel' | 'mission_plan_not_found' | 'backend_unavailable';
  advisors: Array<Pick<MissionAdvisor, 'team_role' | 'agent_id' | 'staffing_state'>>;
  opinions: AdvisoryOpinion[];
  /** Opinions that survived the panel's own critique, in panel order. */
  surviving_opinions: AdvisoryOpinion[];
}

function buildAdvisorPrompt(input: {
  advisor: MissionAdvisor;
  topic: string;
  question: string;
  context?: string;
}): string {
  return [
    `You are the ${input.advisor.team_role} on this mission team.`,
    input.advisor.participant.perspective_ids.length > 0
      ? `Your perspectives: ${input.advisor.participant.perspective_ids.join(', ')}.`
      : '',
    '',
    `Topic: ${input.topic}`,
    input.context ? `Context:\n${input.context}` : '',
    '',
    `Question: ${input.question}`,
    '',
    'Answer from your role only — say what your role is accountable for and what',
    'it would object to. Do not answer as the whole team, and do not repeat the',
    'question. Three sentences at most.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function consultMissionAdvisors(input: {
  missionId: string;
  topic: string;
  question: string;
  context?: string;
  roles?: string[];
  excludeRoles?: string[];
  includeStandby?: boolean;
  maxAdvisors?: number;
  /** Skip the panel's cross-critique round (opinions only). */
  skipCritique?: boolean;
}): Promise<MissionAdvisoryConsultation> {
  const missionId = input.missionId.toUpperCase();
  const base: MissionAdvisoryConsultation = {
    mission_id: missionId,
    topic: input.topic,
    status: 'no_panel',
    advisors: [],
    opinions: [],
    surviving_opinions: [],
  };
  const plan = loadMissionTeamPlan(missionId);
  if (!plan) {
    return { ...base, status: 'mission_plan_not_found' };
  }

  const panel = buildMissionAdvisoryPanel(missionId, {
    ...(input.roles ? { roles: input.roles } : {}),
    ...(input.excludeRoles ? { excludeRoles: input.excludeRoles } : {}),
    ...(input.includeStandby === false ? { includeStandby: false } : {}),
    ...(typeof input.maxAdvisors === 'number' ? { maxAdvisors: input.maxAdvisors } : {}),
  });
  if (panel.length === 0) return base;

  const backend = getReasoningBackend();
  // The panel carries the participant scope, but merely checking read_tiers
  // is not enough: the following prompt and critique calls are the actual
  // egress boundary. Filter backends that the participant forbids before any
  // prompt is constructed, then also install the ambient payload scope below
  // so provider adapters enforce the same tier at the transport boundary.
  const eligiblePanel = panel.filter((advisor) => {
    const egress = validateReasoningEgress(advisor.participant.security_scope, backend.name);
    if (egress.allowed) return true;
    logger.warn(
      `[advisory] ${missionId}: ${advisor.team_role} excluded from ${backend.name}: ${egress.reason}`
    );
    return false;
  });
  if (eligiblePanel.length === 0) return base;

  const advisors = eligiblePanel.map((advisor) => ({
    team_role: advisor.team_role,
    agent_id: advisor.agent_id,
    staffing_state: advisor.staffing_state,
  }));

  if (backend.name === 'stub') {
    return { ...base, status: 'backend_unavailable', advisors };
  }

  const opinions: AdvisoryOpinion[] = [];
  const payloadScope = {
    tier: plan.tier as 'personal' | 'confidential' | 'public',
    ...(plan.tenant_slug ? { tenant_slug: plan.tenant_slug } : {}),
    purpose: `mission advisory:${input.topic}`,
  } as const;
  for (const advisor of eligiblePanel) {
    try {
      const answer = await withReasoningPayloadScope(payloadScope, () =>
        backend.prompt(
          buildAdvisorPrompt({
            advisor,
            topic: input.topic,
            question: input.question,
            ...(input.context ? { context: input.context } : {}),
          })
        )
      );
      opinions.push({
        team_role: advisor.team_role,
        agent_id: advisor.agent_id,
        participant_id: advisor.participant.participant_id,
        perspective_ids: advisor.participant.perspective_ids,
        opinion: answer.trim().slice(0, 2000),
        survived: true,
      });
    } catch (error) {
      logger.warn(
        `[advisory] ${missionId}: ${advisor.team_role} did not answer: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (opinions.length === 0) {
    return { ...base, status: 'backend_unavailable', advisors };
  }

  // The panel critiques itself: an opinion nobody can defend should not reach
  // the decision as if it had.
  if (!input.skipCritique && opinions.length > 1) {
    try {
      const critique = await withReasoningPayloadScope(payloadScope, () =>
        backend.crossCritique({
          topic: input.topic,
          hypotheses: opinions.map((opinion, index) => ({
            id: `${index}`,
            proposed_by: opinion.participant_id,
            content: opinion.opinion,
          })),
          personas: opinions.map((opinion) => opinion.participant_id),
        })
      );
      for (const [index, opinion] of opinions.entries()) {
        const verdict = critique.hypotheses.find((entry) => entry.id === `${index}`);
        if (!verdict) continue;
        opinion.survived = verdict.survived !== false;
        if (verdict.rejection_reason) opinion.rejection_reason = verdict.rejection_reason;
      }
    } catch (error) {
      logger.warn(
        `[advisory] ${missionId}: cross-critique skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  appendMissionExecutionLedgerEntry({
    mission_id: missionId,
    event_type: 'advisory_consultation',
    decision: `${opinions.filter((opinion) => opinion.survived).length}/${opinions.length} opinions survived the panel critique`,
    payload: {
      topic: input.topic,
      question: input.question,
      backend: backend.name,
      advisors,
      opinions: opinions.map((opinion) => ({
        team_role: opinion.team_role,
        agent_id: opinion.agent_id,
        survived: opinion.survived,
        ...(opinion.rejection_reason ? { rejection_reason: opinion.rejection_reason } : {}),
        opinion: opinion.opinion,
      })),
    },
  });

  return {
    mission_id: missionId,
    topic: input.topic,
    status: 'completed',
    advisors,
    opinions,
    surviving_opinions: opinions.filter((opinion) => opinion.survived),
  };
}
