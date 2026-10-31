/** Existing dot wake metering and egress context, independent of the runtime driver. */
import { estimateTokens } from '../foundation/text.js';
import { withUsageAttribution } from '../usage-accounting.js';
import { withReasoningPayloadScope } from '../reasoning/reasoning-egress-scope.js';
import { withoutAutomaticReasoningRedispatch } from '../reasoning/reasoning-dispatch-scope.js';
import type { DotCharter } from './dot-charter.js';
import type { DotWakeSemanticCapture } from './dot-wake-semantic-observer.js';

/** Same ~3-chars/token heuristic as the goal driver; governance-grade only. */
export function estimateWakeTokensFromText(input: {
  prompt: string;
  result: { text?: string; toolCalls?: Array<{ name: string; input: unknown }> };
}): number {
  const responseText = [
    input.result.text ?? '',
    ...(input.result.toolCalls ?? []).map((call) => `${call.name} ${JSON.stringify(call.input)}`),
  ].join(' ');
  return estimateTokens(input.prompt) + estimateTokens(responseText);
}

/** Caller passes the current event attempt at invocation time, after any durable claim. */
export function withDotWakeUsage<T>(
  charter: DotCharter,
  accounting_id: string,
  eventAttemptId: string | undefined,
  fn: () => T,
  capture?: DotWakeSemanticCapture
): T {
  return withUsageAttribution(
    { actor_id: `dot:${charter.dot_id}`, accounting_id, scope: charter.scope },
    () =>
      withReasoningPayloadScope(
        {
          tier: charter.scope.tier,
          tenant_slug: charter.scope.tenant_slug,
          purpose: 'dot-wake',
          training_use:
            charter.runtime.reasoning_training_use ??
            (charter.scope.tier === 'public' ? 'training_eligible' : 'local_only'),
        },
        () => {
          try {
            capture?.usage();
          } catch {
            /* Observation cannot change baseline work. */
          }
          return eventAttemptId ? withoutAutomaticReasoningRedispatch(fn) : fn();
        }
      )
  );
}
