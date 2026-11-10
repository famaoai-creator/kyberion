import {
  resolveIntentResolutionPacket,
  type IntentResolutionOptions,
  type IntentResolutionPacket,
} from './intent-resolution.js';
import {
  classifyOrganizationWork,
  type OrganizationWorkClassification,
} from './organization-work-classification.js';

/*
 * The intent resolver entry (concept model v2, D7; stage R3 of the intent
 * resolver unification plan): the one production module that reads utterance
 * text through `resolveIntentResolutionPacket`
 * (tests/intent-resolver-entry-boundary.test.ts). `resolveRoutingDecision`
 * (routing-decision.ts) builds the RoutingDecision on top of it; surfaces,
 * discussion outcomes, contract builders and evals read through here and
 * carry the packet downstream instead of resolving the text again.
 *
 * Leaf on purpose: it imports only the resolver and the organization-work
 * classifier, so contract builders can use it without an import cycle.
 */

/**
 * Packet-only form of the entry, for callers that need the candidates and
 * parameters but derive no decision of their own (contract builders, evals,
 * the surface router). It reads the utterance exactly like
 * `resolveRoutingDecision`; carry the packet instead of calling this twice.
 */
export function resolveRoutingPacket(
  utterance: string,
  options: IntentResolutionOptions = {}
): IntentResolutionPacket {
  return resolveIntentResolutionPacket(utterance, options);
}

/** One read of an organization request: the packet and the organization work shape. */
export interface ResolvedOrganizationWorkRouting {
  packet: IntentResolutionPacket;
  organizationWork: OrganizationWorkClassification;
}

/**
 * Resolve an organization work request once and classify its organization
 * work shape from the same read (the classifier formerly lived, and read the
 * text separately, in the organization facade).
 */
export function resolveOrganizationWorkRouting(
  utterance: string,
  options: IntentResolutionOptions = {}
): ResolvedOrganizationWorkRouting {
  const packet = resolveIntentResolutionPacket(utterance, options);
  return {
    packet,
    organizationWork: classifyOrganizationWork(
      utterance,
      packet.selected_resolution?.task_kind || packet.selected_resolution?.shape
    ),
  };
}

/**
 * Surface facts the resolver weighs when deciding whether a surface turn must
 * pass through the shared intent compiler. These were per-surface branches in
 * surface-runtime-router.ts; surfaces now only report the facts.
 */
export interface RoutingSurfaceAttributes {
  /** The surface agent that received the turn (e.g. `slack-surface-agent`). */
  agent_id?: string;
  /** Length of the user's own utterance (not the composed routing text). */
  utterance_length: number;
  /** Length of the composed routing text (thread context + message). */
  routing_text_length: number;
  /** The utterance spans more than one line. */
  multiline: boolean;
  /** The surface provider policy forces delegation for this text (Slack). */
  provider_forces_delegation?: boolean;
  /** A mission-team handoff (mission id + team role) owns its delegation path. */
  mission_team_handoff?: boolean;
  /** The surface already selected a receiver by rule or by explicit request. */
  has_rule_based_receiver?: boolean;
}

/** Surfaces whose ordinary turns stay conversational unless their provider policy forces delegation. */
const CONVERSATIONAL_FIRST_AGENTS = new Set(['slack-surface-agent']);
/** Surfaces whose explicit receiver route is a direct A2A handoff. */
const DIRECT_HANDOFF_AGENTS = new Set(['presence-surface-agent']);
/** Above this selection confidence a governed shape or approval plan must compile. */
const CONFIDENT_SELECTION = 0.8;
/** Unresolved text longer than this (or multi-line) compiles rather than routing directly. */
const LONG_UTTERANCE_LENGTH = 80;

/**
 * Decide whether a surface turn must pass through the shared intent compiler.
 * `packet` is read lazily so turns settled by surface facts alone never
 * resolve; `matchesTaskSession` is the task-session classifier over the same
 * packet (injected because the task layer imports this entry).
 */
export function decideSurfaceCompilation(
  attributes: RoutingSurfaceAttributes,
  packet: () => IntentResolutionPacket,
  matchesTaskSession: (packet: IntentResolutionPacket) => boolean
): boolean {
  const agentId = attributes.agent_id ?? '';
  if (attributes.routing_text_length === 0 || attributes.utterance_length === 0) return false;
  if (CONVERSATIONAL_FIRST_AGENTS.has(agentId) && !attributes.provider_forces_delegation) {
    return false;
  }
  // Mission-team handoff already has a dedicated delegation path and must
  // not be replaced by a clarification response from the shared compiler.
  if (attributes.mission_team_handoff) return false;
  // Presence already owns an explicit receiver route that must remain a
  // direct A2A handoff. Other surfaces still pass forced receivers through
  // the shared compiler so a caller cannot bypass governed classification.
  if (DIRECT_HANDOFF_AGENTS.has(agentId) && attributes.has_rule_based_receiver) return false;
  const resolved = packet();
  const selectedShape = resolved.selected_resolution?.shape;
  const governedShape =
    selectedShape === 'task_session' ||
    selectedShape === 'mission' ||
    selectedShape === 'project_bootstrap' ||
    selectedShape === 'pipeline';
  const approvalIntent = resolved.candidates.some(
    (candidate) =>
      candidate.intent_id === resolved.selected_intent_id &&
      candidate.resolution?.result_shape === 'plan'
  );
  const confident = (resolved.selected_confidence || 0) >= CONFIDENT_SELECTION;

  // Lightweight direct replies can keep their deterministic route. Governed
  // shapes, unresolved requests, and approval-ready plans must pass through
  // the shared compiler before any surface-specific delegation is selected.
  if (!resolved.selected_intent_id) return !CONVERSATIONAL_FIRST_AGENTS.has(agentId);
  if (
    (confident && governedShape) ||
    (confident && approvalIntent) ||
    matchesTaskSession(resolved)
  ) {
    return true;
  }
  if (attributes.has_rule_based_receiver) return false;
  return attributes.utterance_length > LONG_UTTERANCE_LENGTH || attributes.multiline;
}
