import {
  compileScopedContextPack,
  validateReasoningEgress,
  type CompiledContextPack,
  type ContextSecurityScope,
  type GovernedContextFragment,
} from './context-security-scope.js';

export interface ReasoningParticipant {
  participant_id: string;
  organization_role_id?: string;
  team_role_id: string;
  perspective_ids: string[];
  agent_profile_id: string;
  authority_role_id: string;
  reasoning_route_id: string;
  security_scope: ContextSecurityScope;
}

export interface ResolvedReasoningParticipant<T = unknown> {
  participant: ReasoningParticipant;
  context_pack: CompiledContextPack<T>;
  backend_name: string;
}

export function validateReasoningParticipant(participant: ReasoningParticipant): string[] {
  const errors: string[] = [];
  for (const [field, value] of Object.entries({
    participant_id: participant.participant_id,
    team_role_id: participant.team_role_id,
    agent_profile_id: participant.agent_profile_id,
    authority_role_id: participant.authority_role_id,
    reasoning_route_id: participant.reasoning_route_id,
  })) {
    if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${field} is required`);
  }
  if (!participant.perspective_ids?.length) errors.push('perspective_ids must not be empty');
  if (participant.security_scope.participant_id !== participant.participant_id) {
    errors.push('security_scope.participant_id must match participant_id');
  }
  return errors;
}

export function resolveReasoningParticipant<T>(input: {
  participant: ReasoningParticipant;
  candidate_fragments?: GovernedContextFragment<T>[];
  backend_name: string;
}): ResolvedReasoningParticipant<T> {
  const errors = validateReasoningParticipant(input.participant);
  if (errors.length > 0) {
    throw new Error(`[REASONING_PARTICIPANT_INVALID] ${errors.join('; ')}`);
  }
  const egress = validateReasoningEgress(input.participant.security_scope, input.backend_name);
  if (!egress.allowed) throw new Error(egress.reason);
  return {
    participant: input.participant,
    context_pack: compileScopedContextPack(
      input.participant.security_scope,
      input.candidate_fragments || []
    ),
    backend_name: input.backend_name,
  };
}

export function renderReasoningParticipantContext<T>(
  resolved: ResolvedReasoningParticipant<T>
): Record<string, unknown> {
  return {
    participant_id: resolved.participant.participant_id,
    organization_role_id: resolved.participant.organization_role_id ?? null,
    team_role_id: resolved.participant.team_role_id,
    perspective_ids: resolved.participant.perspective_ids,
    agent_profile_id: resolved.participant.agent_profile_id,
    authority_role_id: resolved.participant.authority_role_id,
    reasoning_route_id: resolved.participant.reasoning_route_id,
    security_scope: resolved.context_pack.security_scope,
    context_fragments: resolved.context_pack.fragments.map((fragment) => ({
      fragment_id: fragment.fragment_id,
      source_ref: fragment.source_ref,
      content: fragment.content,
    })),
  };
}
