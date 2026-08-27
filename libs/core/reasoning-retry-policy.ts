/** Retry and cancellation policy shared by reasoning provider adapters. */

import { getRegisteredEnvText } from './foundation/env.js';

// Auth/eligibility failures (dead credentials, retired tiers) do not heal in
// seconds — keep retrying them per call and every operation pays the latency.
export const AUTH_FAILURE_PATTERN =
  /IneligibleTier|authenticat|unauthorized|invalid api key|login required|credential|permission denied/i;
export const AUTH_FAILURE_DEMOTION_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_IN_PLACE_RETRIES = 3;
export const DEFAULT_RETRY_BASE_MS = 250;
export function resolveDemotionRetryAfterMs(message: string): number | undefined {
  return AUTH_FAILURE_PATTERN.test(message) ? AUTH_FAILURE_DEMOTION_MS : undefined;
}

export function readRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    retryAfterMs?: unknown;
    retry_after_ms?: unknown;
    retryAfter?: unknown;
    response?: { headers?: Record<string, unknown> };
    headers?: Record<string, unknown>;
  };
  const direct = candidate.retryAfterMs ?? candidate.retry_after_ms;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;

  const headerValue =
    candidate.retryAfter ??
    candidate.headers?.['retry-after'] ??
    candidate.response?.headers?.['retry-after'];
  if (typeof headerValue === 'number' && Number.isFinite(headerValue) && headerValue >= 0) {
    return headerValue * 1000;
  }
  if (typeof headerValue !== 'string' || !headerValue.trim()) return undefined;
  const seconds = Number(headerValue.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(headerValue);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

export function resolveInPlaceRetryCount(policyDefault?: number): number {
  const raw = getRegisteredEnvText('KYBERION_REASONING_IN_PLACE_RETRIES');
  if (!raw?.trim()) return policyDefault ?? DEFAULT_IN_PLACE_RETRIES;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0
    ? Math.min(policyDefault ?? 5, Math.floor(configured))
    : (policyDefault ?? DEFAULT_IN_PLACE_RETRIES);
}

export function resolveRetryBaseMs(): number {
  const raw = getRegisteredEnvText('KYBERION_REASONING_RETRY_BASE_MS');
  if (!raw?.trim()) return DEFAULT_RETRY_BASE_MS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_RETRY_BASE_MS;
}

export function resolveInPlaceRetryDelayMs(error: unknown, retryAttempt: number): number {
  const retryAfterMs = readRetryAfterMs(error);
  if (retryAfterMs !== undefined) return Math.round(retryAfterMs);
  const exponential = resolveRetryBaseMs() * 2 ** Math.max(0, retryAttempt - 1);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function throwIfReasoningAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('[DELEGATION_CANCELLED] reasoning operation aborted');
}

// ---------------------------------------------------------------------------
