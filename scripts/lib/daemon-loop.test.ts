import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitChildWithDeadline,
  ChildDeadlineError,
  installGracefulShutdown,
  startSerialTickLoop,
  type ShutdownProcess,
  type ShutdownSignal,
  type SupervisableChild,
} from './daemon-loop.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('startSerialTickLoop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never overlaps ticks: the next tick is armed only after the previous settles', async () => {
    const gates: Array<{ resolve: () => void }> = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const tick = vi.fn(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      concurrent -= 1;
    });
    const loop = startSerialTickLoop({ intervalMs: 1000, tick, immediate: false });

    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(loop.inFlight).toBe(true);
    // A slow tick spanning many intervals must not start another one.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);

    gates[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.inFlight).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    gates[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(maxConcurrent).toBe(1);
    await loop.stop(100);
  });

  it('routes periodic tick errors to onError and keeps ticking', async () => {
    const onError = vi.fn();
    const tick = vi.fn(async () => {
      throw new Error('boom');
    });
    const loop = startSerialTickLoop({ intervalMs: 500, tick, onError, immediate: false });
    await vi.advanceTimersByTimeAsync(1500);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    await loop.stop(100);
  });

  it('keeps an immediate first-tick failure fatal and stops the loop', async () => {
    const tick = vi.fn(async () => {
      throw new Error('startup');
    });
    const loop = startSerialTickLoop({ intervalMs: 500, tick });
    await expect(loop.firstTick).rejects.toThrow('startup');
    expect(loop.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('stop() drains an in-flight tick, or reports timed_out after the grace bound', async () => {
    const gate = deferred();
    const tick = vi.fn(() => gate.promise);
    const loop = startSerialTickLoop({ intervalMs: 500, tick });

    const stopping = loop.stop(1000);
    await vi.advanceTimersByTimeAsync(200);
    gate.resolve();
    await expect(stopping).resolves.toBe('drained');
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1);

    const stuck = startSerialTickLoop({ intervalMs: 500, tick: () => new Promise(() => {}) });
    const stuckStop = stuck.stop(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(stuckStop).resolves.toBe('timed_out');

    const idle = startSerialTickLoop({ intervalMs: 500, tick: async () => {}, immediate: false });
    await expect(idle.stop(1000)).resolves.toBe('idle');
  });
});

describe('installGracefulShutdown', () => {
  const previousExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.useRealTimers();
  });

  function fakeProcess() {
    const emitter = new EventEmitter();
    const exit = vi.fn();
    const proc: ShutdownProcess = {
      once: (event: ShutdownSignal, listener: () => void) => emitter.once(event, listener),
      exit,
    };
    return { emitter, exit, proc };
  }

  it('runs shutdown once on SIGTERM, sets exit code 0 and force-exits only as a fallback', async () => {
    vi.useFakeTimers();
    const { emitter, exit, proc } = fakeProcess();
    const shutdown = vi.fn(async () => {});
    const trigger = installGracefulShutdown({ name: 'test-daemon', shutdown, proc });

    emitter.emit('SIGTERM');
    await trigger('SIGINT'); // concurrent second request joins the first
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
    expect(process.exitCode).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('handles SIGINT and reports a failing shutdown with exit code 1', async () => {
    vi.useFakeTimers();
    const { emitter, exit, proc } = fakeProcess();
    const trigger = installGracefulShutdown({
      name: 'test-daemon',
      shutdown: async () => {
        throw new Error('lock release failed');
      },
      proc,
      forceExitAfterMs: 10,
    });
    emitter.emit('SIGINT');
    await trigger('SIGINT');
    expect(process.exitCode).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('awaitChildWithDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeChild(exitOn: NodeJS.Signals[] = ['SIGTERM']) {
    const emitter = new EventEmitter();
    const kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal && exitOn.includes(signal))
        queueMicrotask(() => emitter.emit('exit', null, signal));
      return true;
    });
    const child: SupervisableChild = { kill, once: emitter.once.bind(emitter) };
    return { emitter, kill, child };
  }

  it('resolves on exit 0 and rejects on a non-zero exit', async () => {
    const ok = fakeChild();
    const okRun = awaitChildWithDeadline(ok.child, { label: 'tick', deadlineMs: 1000 });
    ok.emitter.emit('exit', 0, null);
    await expect(okRun).resolves.toBeUndefined();

    const bad = fakeChild();
    const badRun = awaitChildWithDeadline(bad.child, { label: 'tick', deadlineMs: 1000 });
    bad.emitter.emit('exit', 3, null);
    await expect(badRun).rejects.toThrow('tick failed with exit code 3');
    await vi.advanceTimersByTimeAsync(5000);
    expect(bad.kill).not.toHaveBeenCalled();
  });

  it("turns a spawn 'error' into a rejection instead of an unhandled crash", async () => {
    const { emitter, child } = fakeChild();
    const run = awaitChildWithDeadline(child, { label: 'tick', deadlineMs: 1000 });
    emitter.emit('error', new Error('spawn ENOENT'));
    await expect(run).rejects.toThrow('spawn ENOENT');
  });

  it('kills the child at the deadline and escalates to SIGKILL when SIGTERM is ignored', async () => {
    const polite = fakeChild(['SIGTERM']);
    const politeRun = awaitChildWithDeadline(polite.child, { label: 'tick', deadlineMs: 1000 });
    const politeResult = expect(politeRun).rejects.toBeInstanceOf(ChildDeadlineError);
    await vi.advanceTimersByTimeAsync(1000);
    await politeResult;
    expect(polite.kill).toHaveBeenCalledWith('SIGTERM');
    expect(polite.kill).not.toHaveBeenCalledWith('SIGKILL');

    const stubborn = fakeChild([]);
    const stubbornRun = awaitChildWithDeadline(stubborn.child, {
      label: 'tick',
      deadlineMs: 1000,
      killGraceMs: 500,
    });
    const stubbornResult = expect(stubbornRun).rejects.toThrow('exceeded its 1000ms deadline');
    await vi.advanceTimersByTimeAsync(1500);
    await stubbornResult;
    expect(stubborn.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
