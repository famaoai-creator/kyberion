import type { ContextSecurityScope } from './context-security-scope.js';
import type { ReasoningParticipant } from './reasoning-participant.js';

export type ParticipantRisk = 'low' | 'medium' | 'high' | 'high_stakes';

export interface ParticipantResolutionInput {
  participant_id: string;
  team_role_id: string;
  security_scope: ContextSecurityScope;
  risk?: ParticipantRisk;
  organization_role_id?: string;
  agent_profile_id?: string;
  authority_role_id?: string;
  perspective_ids?: string[];
  reasoning_route_id?: string;
}

export interface ParticipantResolution {
  participant: ReasoningParticipant;
  selection_reason_codes: string[];
}

interface TeamRoleResolutionDefault {
  authority_role_id: string;
  perspective_ids: string[];
  organization_role_id?: string;
}

const TEAM_ROLE_DEFAULTS: Record<string, TeamRoleResolutionDefault> = {
  owner: {
    authority_role_id: 'mission_controller',
    perspective_ids: ['value_maximizer'],
    organization_role_id: 'business_owner',
  },
  planner: {
    authority_role_id: 'ecosystem_architect',
    perspective_ids: ['pragmatic_cto'],
    organization_role_id: 'product_manager',
  },
  product_strategist: {
    authority_role_id: 'ecosystem_architect',
    perspective_ids: ['visionary_inventor', 'value_maximizer'],
    organization_role_id: 'product_manager',
  },
  experience_designer: {
    authority_role_id: 'software_developer',
    perspective_ids: ['empathetic_cxo'],
    organization_role_id: 'designer',
  },
  implementer: {
    authority_role_id: 'software_developer',
    perspective_ids: ['focused_craftsman'],
    organization_role_id: 'software_developer',
  },
  reviewer: {
    authority_role_id: 'ecosystem_architect',
    perspective_ids: ['rigorous_validator'],
    organization_role_id: 'qa_lead',
  },
  tester: {
    authority_role_id: 'software_developer',
    perspective_ids: ['rigorous_validator'],
    organization_role_id: 'qa_lead',
  },
  attacker: {
    authority_role_id: 'ecosystem_architect',
    perspective_ids: ['security_attacker'],
    organization_role_id: 'cyber_security',
  },
  defender: {
    authority_role_id: 'ecosystem_architect',
    perspective_ids: ['security_defender'],
    organization_role_id: 'cyber_security',
  },
  devils_advocate: {
    authority_role_id: 'ecosystem_architect',
    perspective_ids: ['ruthless_auditor'],
    organization_role_id: 'pmo_governance',
  },
  facilitator: {
    authority_role_id: 'mission_controller',
    perspective_ids: ['calm_facilitator'],
    organization_role_id: 'line_manager',
  },
  relationship_curator: {
    authority_role_id: 'mission_controller',
    perspective_ids: ['empathetic_cxo'],
    organization_role_id: 'customer_success',
  },
  scribe: {
    authority_role_id: 'ecosystem_architect',
    perspective_ids: ['infinite_librarian'],
    organization_role_id: 'knowledge_steward',
  },
  tracker: {
    authority_role_id: 'mission_controller',
    perspective_ids: ['governance_sentinel'],
    organization_role_id: 'pmo_governance',
  },
  operator: {
    authority_role_id: 'chronos_operator',
    perspective_ids: ['calm_responder'],
    organization_role_id: 'reliability_engineer',
  },
  orchestrator: {
    authority_role_id: 'mission_controller',
    perspective_ids: ['governance_sentinel'],
    organization_role_id: 'pmo_governance',
  },
  surface_liaison: {
    authority_role_id: 'surface_runtime',
    perspective_ids: ['sovereign_concierge'],
    organization_role_id: 'sovereign_concierge',
  },
  counterparty_persona: {
    authority_role_id: 'ecosystem_architect',
    perspective_ids: ['counterparty_modeler'],
  },
};

function defaultReasoningRoute(risk: ParticipantRisk): string {
  return risk === 'high' || risk === 'high_stakes' ? 'high-confidence' : 'default';
}

export function resolveParticipantContext(
  input: ParticipantResolutionInput
): ParticipantResolution {
  const defaults = TEAM_ROLE_DEFAULTS[input.team_role_id];
  if (!defaults) {
    throw new Error(
      `[PARTICIPANT_ROLE_UNRESOLVED] No deterministic participant mapping for ${input.team_role_id}`
    );
  }
  if (input.security_scope.participant_id !== input.participant_id) {
    throw new Error(
      '[PARTICIPANT_SCOPE_MISMATCH] security_scope.participant_id must match participant_id'
    );
  }

  const risk = input.risk || 'medium';
  const reasonCodes = [`TEAM_ROLE_${input.team_role_id.toUpperCase()}_DEFAULT`];
  if (input.agent_profile_id) reasonCodes.push('AGENT_PROFILE_EXPLICIT');
  if (input.authority_role_id) reasonCodes.push('AUTHORITY_ROLE_EXPLICIT');
  if (input.perspective_ids?.length) reasonCodes.push('PERSPECTIVES_EXPLICIT');
  if (input.reasoning_route_id) reasonCodes.push('REASONING_ROUTE_EXPLICIT');
  else
    reasonCodes.push(
      risk === 'high' || risk === 'high_stakes' ? 'RISK_HIGH_ROUTE' : 'RISK_DEFAULT_ROUTE'
    );

  return {
    participant: {
      participant_id: input.participant_id,
      ...(input.organization_role_id || defaults.organization_role_id
        ? { organization_role_id: input.organization_role_id || defaults.organization_role_id }
        : {}),
      team_role_id: input.team_role_id,
      perspective_ids: input.perspective_ids?.length
        ? [...input.perspective_ids]
        : [...defaults.perspective_ids],
      agent_profile_id: input.agent_profile_id || 'reasoning-worker',
      authority_role_id: input.authority_role_id || defaults.authority_role_id,
      reasoning_route_id: input.reasoning_route_id || defaultReasoningRoute(risk),
      security_scope: {
        ...input.security_scope,
        read_tiers: [...input.security_scope.read_tiers],
      },
    },
    selection_reason_codes: reasonCodes,
  };
}

export function listDeterministicParticipantTeamRoles(): string[] {
  return Object.keys(TEAM_ROLE_DEFAULTS).sort();
}
