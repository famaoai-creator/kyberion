/**
 * RoutingDecision — the one decision the intent resolver emits per request
 * (concept model v2, D7).
 *
 * Only the intent resolver reads utterance text. It resolves a request once and
 * hands this decision downstream; consumers act on it instead of re-resolving
 * the utterance. The promotion verdict ("does this become a mission?") comes
 * from work-scope-policy.json alone.
 *
 * Leaf module on purpose: it imports nothing but the ExecutionShape vocabulary,
 * so any layer can carry the decision without pulling the resolver in.
 */
import { EXECUTION_SHAPE_VALUES, type ExecutionShape } from './execution-shape.js';

/** Who may let the request proceed: the system alone, an approver, or the requester. */
export type RoutingAuthorityLevel =
  'autonomous' | 'approval_required' | 'human_clarification_required';

/** Whether the request is one deliverable or durable, governed program work. */
export type RoutingDeliveryMode = 'one_shot' | 'managed_program';

/** The mission-promotion verdict, as decided by work-scope-policy.json. */
export interface RoutingPromotionVerdict {
  /** True when the policy promotes the request to mission scope. */
  required: boolean;
  /** The execution shape after the verdict (the catalog shape when not promoted). */
  execution_shape: ExecutionShape;
  /** Why: the policy rationale followed by the triggers that fired. */
  reasons: string[];
  matched_rule_ids: string[];
  policy_version: string;
}

export interface RoutingDecision {
  kind: 'routing_decision';
  /** The selected intent; absent when the resolver had no confident selection. */
  intent_id?: string;
  confidence?: number;
  /** The selected intent's catalog execution shape (`direct_reply` when nothing was selected). */
  execution_shape: ExecutionShape;
  authority_level: RoutingAuthorityLevel;
  delivery_mode: RoutingDeliveryMode;
  promotion: RoutingPromotionVerdict;
}

const EXECUTION_SHAPES = new Set<string>(EXECUTION_SHAPE_VALUES);
const AUTHORITY_LEVELS = new Set<string>([
  'autonomous',
  'approval_required',
  'human_clarification_required',
]);
const DELIVERY_MODES = new Set<string>(['one_shot', 'managed_program']);

/** Narrow a carried value (for example from a runtime context) to a RoutingDecision. */
export function isRoutingDecision(value: unknown): value is RoutingDecision {
  if (!value || typeof value !== 'object') return false;
  const decision = value as Partial<RoutingDecision>;
  const promotion = decision.promotion as Partial<RoutingPromotionVerdict> | undefined;
  return (
    decision.kind === 'routing_decision' &&
    (decision.intent_id === undefined || typeof decision.intent_id === 'string') &&
    EXECUTION_SHAPES.has(String(decision.execution_shape)) &&
    AUTHORITY_LEVELS.has(String(decision.authority_level)) &&
    DELIVERY_MODES.has(String(decision.delivery_mode)) &&
    Boolean(promotion) &&
    typeof promotion?.required === 'boolean' &&
    EXECUTION_SHAPES.has(String(promotion?.execution_shape)) &&
    Array.isArray(promotion?.reasons)
  );
}
