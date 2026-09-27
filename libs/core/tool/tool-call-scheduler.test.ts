import { describe, expect, it } from 'vitest';
import { runToolCallBatch, type ScheduledCall } from './tool-call-scheduler.js';

/**
 * Deterministic concurrency probe: each call pushes 'start' then awaits a
 * gate before pushing 'end', so the trace log proves overlap (two starts
 * before either end) without depending on wall-clock timing.
 */
function trackedCall<T>(
  log: string[],
  name: string,
  claims: ScheduledCall<T>['claims'],
  value: T,
  gate: Promise<void> = Promise.resolve()
): ScheduledCall<T> {
  return {
    claims,
    run: async () => {
      log.push(`start:${name}`);
      await gate;
      log.push(`end:${name}`);
      return value;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('tool-call-scheduler', () => {
  it('runs two reads + a write to a different path in parallel', async () => {
    const log: string[] = [];
    const gateA = deferred();
    const gateB = deferred();
    const gateC = deferred();

    const calls: ScheduledCall<string>[] = [
      trackedCall(
        log,
        'readA',
        [{ kind: 'file', operation: 'read', path: 'a.txt' }],
        'A',
        gateA.promise
      ),
      trackedCall(
        log,
        'readB',
        [{ kind: 'file', operation: 'read', path: 'a.txt' }],
        'B',
        gateB.promise
      ),
      trackedCall(
        log,
        'writeC',
        [{ kind: 'file', operation: 'write', path: 'c.txt' }],
        'C',
        gateC.promise
      ),
    ];

    const settled = runToolCallBatch(calls);
    // All three must have started concurrently before any of them finishes —
    // otherwise this assertion (queued as a microtask after the run() bodies
    // start) would only see a subset of 'start' entries.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['start:readA', 'start:readB', 'start:writeC']);

    gateA.resolve();
    gateB.resolve();
    gateC.resolve();
    const results = await settled;
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason))).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('serializes two writes to the same path', async () => {
    const log: string[] = [];
    const gate1 = deferred();

    const calls: ScheduledCall<string>[] = [
      trackedCall(
        log,
        'write1',
        [{ kind: 'file', operation: 'write', path: 'shared.txt' }],
        'first',
        gate1.promise
      ),
      trackedCall(
        log,
        'write2',
        [{ kind: 'file', operation: 'write', path: 'shared.txt' }],
        'second'
      ),
    ];

    const settled = runToolCallBatch(calls);
    await Promise.resolve();
    await Promise.resolve();
    // write2 must NOT have started yet — write1 is still gated.
    expect(log).toEqual(['start:write1']);

    gate1.resolve();
    const results = await settled;
    expect(log).toEqual(['start:write1', 'end:write1', 'start:write2', 'end:write2']);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason))).toEqual([
      'first',
      'second',
    ]);
  });

  it('runs a batch fully serial when any call is undeclared (conservative all)', async () => {
    const log: string[] = [];
    const gate1 = deferred();

    const calls: ScheduledCall<string>[] = [
      trackedCall(
        log,
        'readA',
        [{ kind: 'file', operation: 'read', path: 'a.txt' }],
        'A',
        gate1.promise
      ),
      trackedCall(log, 'undeclared', [{ kind: 'all' }], 'U'),
      trackedCall(log, 'writeB', [{ kind: 'file', operation: 'write', path: 'b.txt' }], 'W'),
    ];

    const settled = runToolCallBatch(calls);
    await Promise.resolve();
    await Promise.resolve();
    // Only the first call may have started — the presence of the
    // undeclared/`all` call anywhere in the batch forces strict
    // request-order serial execution for every call, not just the ones
    // adjacent to it (readA and writeB never conflict with each other, yet
    // writeB still may not start before the undeclared call finishes).
    expect(log).toEqual(['start:readA']);

    gate1.resolve();
    const results = await settled;
    expect(log).toEqual([
      'start:readA',
      'end:readA',
      'start:undeclared',
      'end:undeclared',
      'start:writeB',
      'end:writeB',
    ]);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason))).toEqual([
      'A',
      'U',
      'W',
    ]);
  });

  it('drains results in request order regardless of finish order (golden)', async () => {
    // Deliberately finish in reverse of request order — the slowest call is
    // requested first, the fastest last — to prove ordering is by request
    // index, not completion time.
    const gateSlow = deferred();
    const calls: ScheduledCall<number>[] = [
      {
        claims: [{ kind: 'file', operation: 'read', path: 'slow.txt' }],
        run: async () => {
          await gateSlow.promise;
          return 1;
        },
      },
      {
        claims: [{ kind: 'file', operation: 'read', path: 'mid.txt' }],
        run: async () => {
          await Promise.resolve();
          return 2;
        },
      },
      {
        claims: [{ kind: 'file', operation: 'read', path: 'fast.txt' }],
        run: async () => 3,
      },
    ];

    const settled = runToolCallBatch(calls);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gateSlow.resolve();
    const results = await settled;
    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 3 },
    ]);
  });

  it('a rejected call does not block unrelated calls, and its reason is captured in place', async () => {
    const calls: ScheduledCall<string>[] = [
      {
        claims: [{ kind: 'file', operation: 'read', path: 'a.txt' }],
        run: async () => {
          throw new Error('boom');
        },
      },
      {
        claims: [{ kind: 'file', operation: 'read', path: 'b.txt' }],
        run: async () => 'ok',
      },
    ];

    const results = await runToolCallBatch(calls);
    expect(results[0]).toEqual({ status: 'rejected', reason: expect.any(Error) });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
  });

  it('treats a recursive claim as covering the whole subtree', async () => {
    const log: string[] = [];
    const gate1 = deferred();
    const calls: ScheduledCall<string>[] = [
      trackedCall(
        log,
        'write-dir',
        [{ kind: 'file', operation: 'write', path: 'knowledge', recursive: true }],
        'dir',
        gate1.promise
      ),
      trackedCall(
        log,
        'read-nested',
        [{ kind: 'file', operation: 'read', path: 'knowledge/product/README.md' }],
        'nested'
      ),
    ];

    const settled = runToolCallBatch(calls);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['start:write-dir']);

    gate1.resolve();
    await settled;
    expect(log).toEqual([
      'start:write-dir',
      'end:write-dir',
      'start:read-nested',
      'end:read-nested',
    ]);
  });

  it('never conflicts two reads of the exact same path', async () => {
    const log: string[] = [];
    const calls: ScheduledCall<string>[] = [
      trackedCall(log, 'read1', [{ kind: 'file', operation: 'read', path: 'same.txt' }], '1'),
      trackedCall(log, 'read2', [{ kind: 'file', operation: 'read', path: 'same.txt' }], '2'),
    ];
    await runToolCallBatch(calls);
    expect(log).toEqual(['start:read1', 'start:read2', 'end:read1', 'end:read2']);
  });
});
