/**
 * Daemon process contract helpers (G09/G10, MSN-OPS-GAPS-20261008).
 *
 * - `startSerialTickLoop`: a self-rescheduling setTimeout loop with an
 *   in-flight guard. The next tick is armed only after the previous one
 *   settles, so ticks never overlap (an async setInterval let a slow tick
 *   race the next one, which the leader lease then misreported as "another
 *   leader owns this tick").
 * - `installGracefulShutdown`: SIGTERM/SIGINT handlers that run a bounded
 *   shutdown routine and exit 0, with a forced exit as the last resort when
 *   stray handles keep the event loop alive.
 */
import { logger } from '@agent/core/core';
import { setProcessExitCode } from './harness.js';

export type SerialTickStopOutcome = 'idle' | 'drained' | 'timed_out';

export interface SerialTickLoopOptions {
  intervalMs: number;
  tick: () => Promise<void>;
  /** Errors from periodic ticks are reported here; the loop keeps running. */
  onError?: (error: unknown) => void;
  /**
   * Run the first tick immediately (default). Its error is NOT routed to
   * `onError`: it rejects `firstTick` and stops the loop, so a startup
   * failure stays fatal for the caller.
   */
  immediate?: boolean;
}

export interface SerialTickLoop {
  readonly inFlight: boolean;
  readonly stopped: boolean;
  /** Settles when the immediate first tick settles (resolved when not immediate). */
  readonly firstTick: Promise<void>;
  /** Stop arming new ticks and wait up to `graceMs` for an in-flight tick. */
  stop(graceMs: number): Promise<SerialTickStopOutcome>;
}

export function startSerialTickLoop(options: SerialTickLoopOptions): SerialTickLoop {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | null = null;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce(false);
    }, options.intervalMs);
  };

  const runOnce = async (first: boolean): Promise<void> => {
    if (stopped || current) return;
    const execution = (async () => options.tick())();
    current = execution.catch(() => undefined);
    try {
      await execution;
    } catch (error) {
      if (first) {
        stopped = true;
        throw error;
      }
      options.onError?.(error);
    } finally {
      current = null;
    }
    arm();
  };

  let firstTick: Promise<void>;
  if (options.immediate === false) {
    firstTick = Promise.resolve();
    arm();
  } else {
    firstTick = runOnce(true);
  }

  return {
    get inFlight() {
      return current !== null;
    },
    get stopped() {
      return stopped;
    },
    firstTick,
    async stop(graceMs: number): Promise<SerialTickStopOutcome> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      const pending = current;
      if (!pending) return 'idle';
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<SerialTickStopOutcome>((resolve) => {
        graceTimer = setTimeout(() => resolve('timed_out'), graceMs);
        graceTimer.unref?.();
      });
      const outcome = await Promise.race([
        pending.then((): SerialTickStopOutcome => 'drained'),
        timedOut,
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      return outcome;
    },
  };
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

/** The subset of `process` the shutdown helper touches (injectable for tests). */
export interface ShutdownProcess {
  once(event: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): void;
}

export interface GracefulShutdownOptions {
  name: string;
  /** Bounded shutdown routine: stop timers, drain work, record heartbeat, release locks. */
  shutdown: (signal: ShutdownSignal) => Promise<void> | void;
  /**
   * After `shutdown` settles the exit code is set to 0 and the event loop is
   * allowed to drain; if a stray handle keeps it alive, force-exit after this
   * many ms (default 2000).
   */
  forceExitAfterMs?: number;
  proc?: ShutdownProcess;
}

/**
 * Install SIGTERM/SIGINT handlers (once each). Returns a promise-returning
 * trigger so callers/tests can run the same path without a real signal.
 */
export function installGracefulShutdown(
  options: GracefulShutdownOptions
): (signal: ShutdownSignal) => Promise<void> {
  const proc: ShutdownProcess = options.proc ?? process;
  const forceExitAfterMs = options.forceExitAfterMs ?? 2000;
  let shuttingDown: Promise<void> | null = null;

  const trigger = (signal: ShutdownSignal): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      logger.info(`[${options.name}] ${signal} received; shutting down`);
      let exitCode = 0;
      try {
        await options.shutdown(signal);
      } catch (error) {
        exitCode = 1;
        logger.error(
          `[${options.name}] shutdown failed — ${error instanceof Error ? error.message : String(error)} | next: inspect the daemon heartbeat and leader lock | evidence: ${signal}`
        );
      }
      setProcessExitCode(exitCode);
      const forceExit = setTimeout(() => proc.exit(exitCode), forceExitAfterMs);
      forceExit.unref?.();
    })();
    return shuttingDown;
  };

  proc.once('SIGTERM', () => void trigger('SIGTERM'));
  proc.once('SIGINT', () => void trigger('SIGINT'));
  return trigger;
}

/** The subset of ChildProcess the deadline supervisor needs (injectable for tests). */
export interface SupervisableChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export class ChildDeadlineError extends Error {
  constructor(
    readonly label: string,
    readonly deadlineMs: number
  ) {
    super(`${label} exceeded its ${deadlineMs}ms deadline and was killed`);
    this.name = 'ChildDeadlineError';
  }
}

/**
 * Await a child process with a hard deadline: resolve on exit 0, reject on a
 * non-zero exit or spawn 'error', and on deadline send SIGTERM, escalate to
 * SIGKILL after `killGraceMs`, and reject with `ChildDeadlineError`.
 */
export function awaitChildWithDeadline(
  child: SupervisableChild,
  options: { label: string; deadlineMs: number; killGraceMs?: number }
): Promise<void> {
  const killGraceMs = options.killGraceMs ?? 5000;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve();
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(new ChildDeadlineError(options.label, options.deadlineMs));
      }, killGraceMs);
    }, options.deadlineMs);
    child.once('exit', (code, signal) => {
      if (timedOut) settle(new ChildDeadlineError(options.label, options.deadlineMs));
      else if (code === 0) settle();
      else
        settle(
          new Error(
            `${options.label} failed with exit code ${code}${signal ? ` (signal ${signal})` : ''}`
          )
        );
    });
    child.once('error', (error) => settle(error));
  });
}
