/**
 * Delivery/retry outcome vocabulary for `computer_interaction` results.
 * Mirrors `tool_result` in knowledge/product/schemas/computer-interaction.schema.json.
 *
 * `delivery` states what the executor established about the action reaching its
 * target; `retry` is derived from it — only `not_delivered` is safe to repeat.
 * Results must not carry unconditional success flags (`clicked: true` proves
 * nothing): `delivered_verified` requires a named postcondition readback, and
 * `delivered_unverified` means a completed dispatch without one.
 */
export type ComputerInteractionDelivery =
  | 'unknown'
  | 'not_delivered'
  | 'delivery_uncertain'
  | 'delivered_unverified'
  | 'delivered_verified';

export type ComputerInteractionRetry = 'unknown' | 'safe' | 'unsafe';

export interface ComputerInteractionDisposition {
  delivery: ComputerInteractionDelivery;
  retry: ComputerInteractionRetry;
}

export interface ComputerInteractionRecovery {
  strategy?: string;
  retryable?: boolean;
  requires_fresh_observation?: boolean;
}

export interface ComputerInteractionOutcome {
  code?: string;
  disposition?: ComputerInteractionDisposition;
  recovery?: ComputerInteractionRecovery;
}

const RETRY_BY_DELIVERY: Record<ComputerInteractionDelivery, ComputerInteractionRetry> = {
  unknown: 'unknown',
  not_delivered: 'safe',
  delivery_uncertain: 'unsafe',
  delivered_unverified: 'unsafe',
  delivered_verified: 'unsafe',
};

export function dispositionFor(
  delivery: ComputerInteractionDelivery
): ComputerInteractionDisposition {
  return { delivery, retry: RETRY_BY_DELIVERY[delivery] };
}

/**
 * Stamp `code` / `disposition` / `recovery` onto a result object or an Error.
 * Existing fields win: a deeper layer that already classified the outcome is
 * never overwritten by an outer boundary. Returns the same object.
 */
export function stampOutcome<T extends object>(target: T, outcome: ComputerInteractionOutcome): T {
  const record = target as Record<string, unknown>;
  if (outcome.code !== undefined && record.code === undefined) record.code = outcome.code;
  if (outcome.disposition !== undefined && record.disposition === undefined) {
    record.disposition = outcome.disposition;
  }
  if (outcome.recovery !== undefined && record.recovery === undefined) {
    record.recovery = outcome.recovery;
  }
  return target;
}
