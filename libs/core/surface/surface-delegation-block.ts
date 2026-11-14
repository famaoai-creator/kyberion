import { logger } from '../core.js';
import {
  A2APerformativeNotRoutableError,
  isA2ARoutablePerformative,
  type A2AMessage,
  type A2ARoutablePerformative,
} from '../mesh/a2a-bridge.js';
import type { SurfaceDelegationResult } from './channel-surface-types.js';

/**
 * Decide what an `a2a` block a surface agent wrote may send to the bridge.
 *
 * A block with a performative the bridge refuses is a drafting mistake, not a
 * policy violation: it is answered here with what to send instead, and the
 * bridge (and its governance record) is left out. A block without a
 * performative is a `request`, as before.
 */
export function resolveSurfaceDelegationPerformative(
  msg: A2AMessage,
  senderAgentId: string
): { performative: A2ARoutablePerformative } | { refused: SurfaceDelegationResult } {
  const performative: unknown = msg.header?.performative || 'request';
  if (isA2ARoutablePerformative(performative)) return { performative };
  const refusal = new A2APerformativeNotRoutableError(performative);
  logger.warn(
    `[surface-runtime] a2a block not delegated — performative "${refusal.performative}" is not routable | emit the block with performative "request" | sender=${senderAgentId} receiver=${msg.header?.receiver ?? 'none'}`
  );
  return { refused: { receiver: msg.header?.receiver, error: refusal.message } };
}

/** Fill a placeholder or empty block text with the original surface request. */
export function normalizeDelegationPayload(payload: any, fallbackText: string): any {
  if (!payload || typeof payload !== 'object') return payload;
  const currentText = typeof payload.text === 'string' ? payload.text.trim() : '';
  const looksPlaceholder =
    currentText === '' ||
    currentText === 'original request and relevant Slack context' ||
    currentText === 'original request';

  if (!looksPlaceholder) return payload;
  return {
    ...payload,
    text: fallbackText,
  };
}
