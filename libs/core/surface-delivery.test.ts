import { describe, expect, it } from 'vitest';
import {
  classifySurfaceDeliveryError,
  createSurfaceOutboxDrainGuard,
  isSurfaceOutboxDue,
  planSurfaceOutboxRetry,
} from './surface-delivery.js';
import { withLock } from './src/lock-utils.js';

describe('surface delivery policy', () => {
  it('classifies permanent, rate-limit, and transient failures', () => {
    expect(classifySurfaceDeliveryError({ status: 403, message: 'not authorized' })).toMatchObject({
      kind: 'forbidden',
      retryable: false,
    });
    expect(
      classifySurfaceDeliveryError({ status: 429, message: 'rate limited', retry_after_ms: 3_000 })
    ).toMatchObject({ kind: 'rate_limited', retryable: true, retry_after_ms: 3_000 });
    expect(classifySurfaceDeliveryError(new Error('ECONNRESET'))).toMatchObject({
      kind: 'transient',
      retryable: true,
    });
  });

  it('backs off retryable failures and dead-letters at the attempt boundary', () => {
    const first = planSurfaceOutboxRetry(
      { attempt_count: 0 },
      { kind: 'transient', retryable: true, reason: 'timeout' },
      1_000,
      { max_attempts: 3, initial_delay_ms: 100, max_delay_ms: 1_000 }
    );
    expect(first).toMatchObject({ attempt_count: 1, dead_letter: false });
    expect(first.next_attempt_at).toBe(new Date(1_100).toISOString());

    const last = planSurfaceOutboxRetry(
      { attempt_count: 2 },
      { kind: 'transient', retryable: true, reason: 'timeout' },
      1_000,
      { max_attempts: 3 }
    );
    expect(last).toMatchObject({ attempt_count: 3, dead_letter: true });

    const permanent = planSurfaceOutboxRetry(
      { attempt_count: 0 },
      { kind: 'not_found', retryable: false, reason: 'unknown channel' },
      1_000
    );
    expect(permanent.dead_letter).toBe(true);
  });

  it('does not redeliver before next_attempt_at', () => {
    expect(isSurfaceOutboxDue({ next_attempt_at: new Date(2_000).toISOString() }, 1_999)).toBe(
      false
    );
    expect(isSurfaceOutboxDue({ next_attempt_at: new Date(2_000).toISOString() }, 2_000)).toBe(
      true
    );
    expect(isSurfaceOutboxDue({}, 0)).toBe(true);
  });

  it('skips overlapping drains and unlocks after the active drain settles', async () => {
    const guard = createSurfaceOutboxDrainGuard();
    let release!: () => void;
    const first = guard(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('first');
        })
    );

    await Promise.resolve();
    await expect(guard(async () => 'overlap')).resolves.toBeUndefined();
    release();
    await expect(first).resolves.toBe('first');
    await expect(guard(async () => 'after-release')).resolves.toBe('after-release');
  });

  it('skips a drain while another process owns the surface coordination lock', async () => {
    const guard = createSurfaceOutboxDrainGuard('slack');
    await withLock('surface-outbox-slack', async () => {
      await expect(guard(async () => 'busy')).resolves.toBeUndefined();
    });
    await expect(guard(async () => 'available')).resolves.toBe('available');
  });
});
