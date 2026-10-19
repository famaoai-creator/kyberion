import { parseInformationFlowFacts } from '../governance/accountability-charter.js';
import { findCharterDecision } from '../governance/charter-decision-vocabulary.js';
import type { OpPreflightCall } from './op-preflight.js';

/** Validate supplied decision facts without consuming charter or approval state.
 * Missing facts belong to the human approval path; malformed supplied facts
 * must be corrected before an approval can meaningfully authorize the action.
 */
export function charterDecisionFactError(input: Record<string, unknown>): string | undefined {
  if (typeof input.decision_type !== 'string') return;
  const entry = findCharterDecision(input.decision_type);
  if (!entry) return;
  if (
    input.amount !== undefined &&
    (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0)
  )
    return 'amount must be a finite nonnegative number';
  if (
    input.recipients !== undefined &&
    (typeof input.recipients !== 'number' ||
      !Number.isSafeInteger(input.recipients) ||
      input.recipients < 0)
  )
    return 'recipients must be a nonnegative safe integer';
  if (input.information_flow !== undefined) {
    const parsed = parseInformationFlowFacts(input.information_flow);
    if (!parsed.ok) return parsed.error;
    if (
      (entry.action_class === 'send_message_external' || entry.action_class === 'publish_public') &&
      !parsed.facts.recipient_class
    )
      return 'external action information_flow needs recipient_class';
  }
}

export function charterDecisionFactGuard(call: OpPreflightCall, input: Record<string, unknown>) {
  if (call.op !== 'approval:evaluate_decision_rights') return;
  const error = charterDecisionFactError(input);
  if (error)
    return {
      decision: 'block' as const,
      reason: `[OP_CHARTER_FACTS_DENIED] ${error}`,
      terminate: true,
    };
}
