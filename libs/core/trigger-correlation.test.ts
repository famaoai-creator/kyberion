import { describe, it, expect, beforeEach } from 'vitest';
import {
  withTriggerCorrelation,
  currentTriggerDeliveryId,
  currentTriggerCorrelation,
} from './trigger-correlation.js';
import { WorkerEventStream, resetDefaultWorkerEventStream } from './worker-event-stream.js';

/**
 * EV-09: one cron firing produced a delivery receipt, a pipeline trace, worker
 * events and possibly a notification, with nothing linking them. The delivery id
 * now rides an async scope so emitters attribute themselves without a threaded
 * parameter.
 */
describe('trigger correlation (EV-09)', () => {
  beforeEach(() => {
    resetDefaultWorkerEventStream();
  });

  const scope = {
    deliveryId: 'cron:daily:2026-08-10T03:00',
    source: 'cron' as const,
    idempotencyKey: 'cron:daily:2026-08-10T03:00',
  };

  it('スコープ外では相関 ID を持たない', () => {
    expect(currentTriggerDeliveryId()).toBeUndefined();
    expect(currentTriggerCorrelation()).toBeUndefined();
  });

  it('スコープ内の worker event に trigger_delivery_id が自動付与される', () => {
    const stream = new WorkerEventStream();
    const seen: Array<Record<string, unknown> | undefined> = [];
    stream.subscribe((event) => seen.push(event.source));

    withTriggerCorrelation(scope, () => {
      stream.emit('step_begin', { op: 'system:exec' });
    });
    stream.emit('step_begin', { op: 'system:exec' });

    expect(seen[0]?.trigger_delivery_id).toBe(scope.deliveryId);
    // Outside the scope the field must be absent, not stale.
    expect(seen[1]?.trigger_delivery_id).toBeUndefined();
  });

  it('明示的な source が周囲のスコープを上書きできる', () => {
    const stream = new WorkerEventStream();
    const seen: Array<Record<string, unknown> | undefined> = [];
    stream.subscribe((event) => seen.push(event.source));

    withTriggerCorrelation(scope, () => {
      stream.emit('step_begin', { op: 'x' }, { trigger_delivery_id: 'explicit-id' });
    });

    expect(seen[0]?.trigger_delivery_id).toBe('explicit-id');
  });

  it('defaultSource と併用しても相関が保たれる', () => {
    const stream = new WorkerEventStream({ mission_id: 'MSN-X' });
    const seen: Array<Record<string, unknown> | undefined> = [];
    stream.subscribe((event) => seen.push(event.source));

    withTriggerCorrelation(scope, () => stream.emit('turn_begin', {}));

    expect(seen[0]).toMatchObject({
      mission_id: 'MSN-X',
      trigger_delivery_id: scope.deliveryId,
    });
  });

  it('非同期境界を越えて相関が維持される', async () => {
    const observed = await withTriggerCorrelation(scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentTriggerDeliveryId();
    });
    expect(observed).toBe(scope.deliveryId);
  });

  it('並行スコープが互いの ID を見ない', async () => {
    const other = { ...scope, deliveryId: 'wake:other', idempotencyKey: 'wake:other' };
    const [a, b] = await Promise.all([
      withTriggerCorrelation(scope, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentTriggerDeliveryId();
      }),
      withTriggerCorrelation(other, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentTriggerDeliveryId();
      }),
    ]);
    expect(a).toBe(scope.deliveryId);
    expect(b).toBe('wake:other');
  });

  it('source と idempotencyKey も参照できる', () => {
    withTriggerCorrelation(scope, () => {
      expect(currentTriggerCorrelation()).toEqual(scope);
    });
  });
});
