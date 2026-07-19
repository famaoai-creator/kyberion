/**
 * Completion Token Dynamic Budget (KC-09) — per-request `max_tokens` sizing
 * for direct-API reasoning backends, modeled on kimi-cli
 * `_compute_completion_overrides`:
 *
 *   max_completion = context_window − estimated_input − safety_margin
 *
 * clamped to [floor, configured max], so a fixed max_tokens never overflows
 * the window and triggers avoidable "prompt too long" errors. CLI-bridge
 * backends are out of scope — the CLI manages its own window. When the window
 * is unknown the configured max passes through unchanged.
 */

import { estimateTokens } from './worker-context-compaction.js';

export const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024;
export const DEFAULT_COMPLETION_FLOOR_TOKENS = 1_024;

export interface CompletionTokenBudgetInput {
  /** Total model context window in tokens; undefined/invalid = unknown → passthrough. */
  contextWindowTokens?: number | undefined;
  estimatedInputTokens: number;
  configuredMaxTokens: number;
  safetyMarginTokens?: number;
  floorTokens?: number;
}

export function computeCompletionTokenBudget(input: CompletionTokenBudgetInput): number {
  const { contextWindowTokens, configuredMaxTokens } = input;
  if (
    contextWindowTokens === undefined ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return configuredMaxTokens;
  }
  const safetyMargin = input.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  const floor = input.floorTokens ?? DEFAULT_COMPLETION_FLOOR_TOKENS;
  const remaining = Math.floor(contextWindowTokens - input.estimatedInputTokens - safetyMargin);
  return Math.min(configuredMaxTokens, Math.max(floor, remaining));
}

/**
 * Input estimate over the serialized request payload — errs high on purpose
 * (tool definitions and output schemas count as input tokens too), consistent
 * with the compaction estimator it reuses.
 */
export function estimateRequestInputTokens(payload: unknown): number {
  try {
    const serialized = JSON.stringify(payload) as string | undefined;
    return estimateTokens(serialized ?? '');
  } catch {
    return 0;
  }
}

/**
 * Explicitly configured window only — no model-table default. Backends whose
 * window cannot be assumed (openai-compatible local models) treat an unset
 * value as unknown and leave the request untouched.
 */
export function resolveConfiguredContextWindowTokens(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const raw = env.KYBERION_CONTEXT_WINDOW_TOKENS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
