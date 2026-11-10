/**
 * Thin RoutingDecision adapter for resident dots (concept model v2, D7 — R3 dot part).
 *
 * A dot never reads utterances: its execution shape is the one it proposed, bounded
 * by its charter (`authority.allowed_execution_shapes`). Like the front desk, it
 * therefore asks for the decision of that configured shape instead of resolving
 * text, and the mission-promotion verdict still comes from work-scope-policy.json
 * alone. Dispatch and the executor act on `promotion.execution_shape` of this
 * decision; a policy that routes the charter-bounded shape elsewhere is refused
 * (the dot re-proposes within its charter), never silently widened.
 */
import type { RoutingDecision } from '../contracts/routing-decision.js';
import { routingDecisionForConfiguredShape } from '../intent/routing-decision.js';
import { DOT_EXECUTION_SHAPES, type DotExecutionShape } from './dot-proposals.js';

export function isDotExecutionShape(value: unknown): value is DotExecutionShape {
  return DOT_EXECUTION_SHAPES.includes(value as DotExecutionShape);
}

/** The RoutingDecision for a charter-bounded dot shape. */
export function dotRoutingDecision(shape: DotExecutionShape): RoutingDecision {
  return routingDecisionForConfiguredShape(shape);
}

/** Refusal reason when work-scope policy routes the dot's shape to another one. */
export function dotRoutingRefusal(
  shape: DotExecutionShape,
  decision: RoutingDecision
): string | undefined {
  const routed = decision.promotion.execution_shape;
  if (routed === shape) return undefined;
  return `work-scope policy routes execution_shape '${shape}' to '${routed}' (${decision.promotion.matched_rule_ids.join(', ') || 'no rule id'}) — re-propose within the charter's allowed_execution_shapes`;
}
