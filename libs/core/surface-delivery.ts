import type {
  SurfaceAsyncChannel,
  SurfaceDeliveryFailure,
  SurfaceOutboxMessage,
} from './channel-surface-types.js';
import {
  clearSurfaceDeadTarget,
  deadLetterSurfaceOutboxMessage,
  markSurfaceDeadTarget,
  updateSurfaceOutboxMessage,
} from './surface-coordination-store.js';
import { sendOpsAlert } from './ops-alert.js';
import { withLock } from './src/lock-utils.js';

export interface SurfaceOutboxRetryDecision {
  attempt_count: number;
  dead_letter: boolean;
  next_attempt_at?: string;
  failure: SurfaceDeliveryFailure;
}

/**
 * Prevent overlapping drains for one surface process.
 *
 * Outbox delivery is intentionally at-least-once, but a timer tick must not
 * start a second pass while the previous pass is still awaiting a provider.
 * The guard is process-local; durable retry/dedup remains the coordination
 * store's responsibility across process restarts.
 */
export function createSurfaceOutboxDrainGuard(
  surface?: SurfaceAsyncChannel
): <T>(drain: () => Promise<T>) => Promise<T | undefined> {
  let running = false;
  return async <T>(drain: () => Promise<T>): Promise<T | undefined> => {
    if (running) return undefined;
    running = true;
    try {
      if (!surface) return await drain();
      try {
        // The local guard prevents timer overlap; this governed lock also
        // prevents duplicate delivery when two bridge processes share the
        // same coordination outbox. A busy peer simply retries on its next
        // scheduled tick instead of waiting behind an in-flight provider call.
        return await withLock(`surface-outbox-${surface}`, drain, 25);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('[LOCK_TIMEOUT]')) {
          return undefined;
        }
        throw error;
      }
    } finally {
      running = false;
    }
  };
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return String(value.message || value.error || value.code || JSON.stringify(value));
  }
  return String(error);
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as Record<string, unknown>;
  const nested =
    value.data && typeof value.data === 'object'
      ? (value.data as Record<string, unknown>)
      : undefined;
  const candidate = value.status ?? value.statusCode ?? value.status_code ?? nested?.status;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as Record<string, unknown>;
  const nested =
    value.data && typeof value.data === 'object'
      ? (value.data as Record<string, unknown>)
      : undefined;
  const candidate =
    value.retry_after_ms ?? value.retryAfterMs ?? nested?.retry_after_ms ?? nested?.retryAfterMs;
  const parsed = Number(candidate);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  const seconds = Number(value.retry_after ?? nested?.retry_after);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

export function classifySurfaceDeliveryError(error: unknown): SurfaceDeliveryFailure {
  const reason = errorText(error).slice(0, 1_000);
  const normalized = reason.toLowerCase();
  const status = statusCode(error);
  const retryAfter = retryAfterMs(error);

  if (status === 429 || /rate.?limit|too many requests|slowmode/u.test(normalized)) {
    return {
      kind: 'rate_limited',
      retryable: true,
      reason,
      ...(retryAfter === undefined ? {} : { retry_after_ms: retryAfter }),
    };
  }
  if (status === 413 || /too.?long|message.?length|payload.?too.?large/u.test(normalized)) {
    return { kind: 'too_long', retryable: false, reason };
  }
  if (
    status === 401 ||
    status === 403 ||
    /forbidden|not.?authorized|invalid.?auth|missing.?access/u.test(normalized)
  ) {
    return { kind: 'forbidden', retryable: false, reason };
  }
  if (
    status === 404 ||
    /not.?found|unknown.?channel|unknown.?conversation|channel.?not.?found/u.test(normalized)
  ) {
    return { kind: 'not_found', retryable: false, reason };
  }
  if (
    status === 400 ||
    /invalid.?format|invalid.?blocks|malformed|parse.?error|bad.?request/u.test(normalized)
  ) {
    return { kind: 'bad_format', retryable: false, reason };
  }
  return {
    kind: 'transient',
    retryable: true,
    reason,
    ...(retryAfter === undefined ? {} : { retry_after_ms: retryAfter }),
  };
}

export function planSurfaceOutboxRetry(
  message: Pick<SurfaceOutboxMessage, 'attempt_count'>,
  failure: SurfaceDeliveryFailure,
  now = Date.now(),
  policy: { max_attempts?: number; initial_delay_ms?: number; max_delay_ms?: number } = {}
): SurfaceOutboxRetryDecision {
  const attempt_count = Math.max(0, Number(message.attempt_count || 0)) + 1;
  const maxAttempts = Math.max(1, policy.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
  const dead_letter = !failure.retryable || attempt_count >= maxAttempts;
  if (dead_letter) return { attempt_count, dead_letter, failure };

  const initial = Math.max(1, policy.initial_delay_ms ?? DEFAULT_INITIAL_DELAY_MS);
  const maximum = Math.max(initial, policy.max_delay_ms ?? DEFAULT_MAX_DELAY_MS);
  const exponential = Math.min(maximum, initial * 2 ** Math.max(0, attempt_count - 1));
  const delay = Math.min(maximum, Math.max(exponential, failure.retry_after_ms || 0));
  return {
    attempt_count,
    dead_letter,
    failure,
    next_attempt_at: new Date(now + delay).toISOString(),
  };
}

export function isSurfaceOutboxDue(
  message: Pick<SurfaceOutboxMessage, 'next_attempt_at'>,
  now = Date.now()
): boolean {
  if (!message.next_attempt_at) return true;
  const next = new Date(message.next_attempt_at).getTime();
  return !Number.isFinite(next) || next <= now;
}

export function settleSurfaceOutboxFailure(
  surface: SurfaceAsyncChannel,
  message: SurfaceOutboxMessage,
  error: unknown,
  now = Date.now()
): SurfaceOutboxRetryDecision {
  const decision = planSurfaceOutboxRetry(message, classifySurfaceDeliveryError(error), now);
  if (decision.failure.kind === 'forbidden' || decision.failure.kind === 'not_found') {
    markSurfaceDeadTarget(surface, message.channel, decision.failure);
  }
  if (decision.dead_letter) {
    deadLetterSurfaceOutboxMessage(surface, message.message_id, decision.failure);
    sendOpsAlert({
      severity: 'critical',
      title: `Surface delivery dead-lettered: ${surface}`,
      context: {
        surface,
        channel: message.channel,
        message_id: message.message_id,
        failure_kind: decision.failure.kind,
        attempt_count: decision.attempt_count,
      },
      recommendation:
        'Inspect the surface dead-letter record and repair the target or payload before replaying.',
      dedupe_key: `surface-dead-letter:${surface}:${message.channel}`,
    });
  } else {
    updateSurfaceOutboxMessage(surface, message.message_id, {
      attempt_count: decision.attempt_count,
      next_attempt_at: decision.next_attempt_at,
      last_error_kind: decision.failure.kind,
      last_error: decision.failure.reason,
    });
  }
  return decision;
}

export function recordSurfaceDeliverySuccess(surface: SurfaceAsyncChannel, channel: string): void {
  clearSurfaceDeadTarget(surface, channel);
}
