import { metrics } from './metrics.js';

/**
 * OP-01 Task 1.2: CLI reasoning backends (gemini/codex) do not report token
 * usage, so cost accounting records an estimate (~4 chars per token) marked
 * `estimated: true` — visibly approximate beats invisibly free. Best-effort:
 * metering never breaks the reasoning path.
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
    metrics.record(component, Date.now() - started, status, {
      model,
      agent: component,
      mission_id: process.env.MISSION_ID || undefined,
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
