import type { RoutingDecision } from '../contracts/routing-decision.js';
import {
  resolveWorkScopeDecision,
  type WorkScopeDecisionInput,
} from '../workforce/work-scope-decision.js';
import { inferGovernedDeliveryMode } from './intent-contract.js';
import { resolveIntentResolutionContract } from './intent-resolution-contract.js';
import {
  resolveIntentResolutionPacket,
  type IntentResolutionOptions,
  type IntentResolutionPacket,
} from './intent-resolution.js';

export interface RoutingDecisionOptions extends IntentResolutionOptions {
  /**
   * Explicit, already-known work-scope facts (never inferred from text here).
   * Omitted facts read as absent, so the verdict is the catalog floor alone.
   */
  workScope?: Omit<WorkScopeDecisionInput, 'catalogMinimumShape'>;
}

/** One request, resolved once: the canonical packet and the decision derived from it. */
export interface ResolvedRouting {
  packet: IntentResolutionPacket;
  decision: RoutingDecision;
}

/**
 * Derive the RoutingDecision from an already-resolved packet. Reads no
 * utterance text beyond what the packet carries and never re-resolves it.
 */
export function buildRoutingDecision(
  packet: IntentResolutionPacket,
  options: RoutingDecisionOptions = {}
): RoutingDecision {
  const contract = resolveIntentResolutionContract(packet.utterance, {
    packet,
    tier: options.tier,
    tenantId: options.tenantId,
    overlayPaths: options.overlayPaths,
  });
  const executionShape = contract.execution_shape ?? 'direct_reply';
  const workScope = resolveWorkScopeDecision({
    ...options.workScope,
    catalogMinimumShape: executionShape,
  });
  return {
    kind: 'routing_decision',
    ...(packet.selected_intent_id ? { intent_id: packet.selected_intent_id } : {}),
    ...(typeof packet.selected_confidence === 'number'
      ? { confidence: packet.selected_confidence }
      : {}),
    execution_shape: executionShape,
    authority_level: contract.authority_level,
    delivery_mode: inferGovernedDeliveryMode(
      packet.utterance,
      executionShape,
      contract.missing_inputs
    ),
    promotion: {
      required: workScope.promotion_required,
      execution_shape: workScope.execution_shape,
      reasons: [
        workScope.rationale,
        ...workScope.mandatory_triggers.map((trigger) => `mandatory trigger: ${trigger}`),
        ...workScope.accumulation_triggers.map((trigger) => `accumulation trigger: ${trigger}`),
      ],
      matched_rule_ids: workScope.matched_rule_ids,
      policy_version: workScope.policy_version,
    },
  };
}

/**
 * The single entry point that reads a request's utterance (concept model v2,
 * D7): resolve it once and emit the RoutingDecision. Callers pass the returned
 * packet and decision downstream instead of re-resolving the text.
 */
export function resolveRoutingDecision(
  utterance: string,
  options: RoutingDecisionOptions = {}
): ResolvedRouting {
  const packet = resolveIntentResolutionPacket(utterance, {
    tier: options.tier,
    tenantId: options.tenantId,
    overlayPaths: options.overlayPaths,
  });
  return { packet, decision: buildRoutingDecision(packet, options) };
}
