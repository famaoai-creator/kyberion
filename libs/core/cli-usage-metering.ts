import { metrics } from './metrics.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { getUsageAttribution } from './usage-accounting.js';

/**
 * OP-01 Task 1.2: CLI reasoning backends (gemini/codex) do not report token
 * usage, so cost accounting records an estimate (~4 chars per token) marked
 * `estimated: true` — visibly approximate beats invisibly free. Best-effort:
 * metering never breaks the reasoning path. Inside a trusted
 * `withUsageAttribution` context (e.g. a dot wake) the row carries the same
 * scope / actor_id / accounting_id as the SDK path, so the budget governor
 * attributes and reconciles it instead of counting it as unscoped mission usage.
 */
export function recordEstimatedCliUsage(
  component: string,
  model: string,
  started: number,
  status: 'success' | 'error',
  promptChars: number,
  completionChars: number
): void {
  try {
    const attribution = getUsageAttribution();
    metrics.record(component, Date.now() - started, status, {
      model,
      agent: component,
      ...(attribution
        ? {
            scope: attribution.scope,
            actor_id: attribution.actor_id,
            ...(attribution.accounting_id ? { accounting_id: attribution.accounting_id } : {}),
          }
        : {}),
      mission_id: getRegisteredEnvText('MISSION_ID') || undefined,
      estimated: true,
      usage: {
        prompt_tokens: Math.ceil(promptChars / 4),
        completion_tokens: Math.ceil(completionChars / 4),
      },
    });
  } catch {
    /* metering must never break reasoning */
  }
}
