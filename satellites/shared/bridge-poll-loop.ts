/**
 * C7 shared daemon/bridge poll-loop helper (`bridge:poll_loop`).
 *
 * Unifies the hand-written `setInterval` pollers across the bridges
 * (imessage/telegram/discord/slack outbox + message polls, telegram
 * long-polling) and the presence-studio speech-state poll, plus the
 * typing-indicator guards.
 *
 * Behavior contract — aligned to the safest current side, never weakened:
 * - fixed `intervalMs` cadence is preserved per caller (no silent re-timing);
 * - duplicate-start guard: a second `start` with the same `name` returns the
 *   running handle instead of arming a second timer;
 * - overlap guard: a tick that is still in flight skips (outbox drains
 *   already no-op via their drain guards; message polls stay single-flight);
 * - interval timers are `unref`d so auxiliary loops never block process exit;
 * - every handle exposes `stop()`; `stopBridgePollLoop(name)` /
 *   `stopAllBridgePollLoops()` cover exit-time cleanup.
 */

import { logger } from '@agent/core/core';
import { scheduleBridgeProcessingNote, startBridgeTypingLoop } from '@agent/core/bridge-typing';

export interface BridgePollBackoff {
  /** First retry delay; defaults to the loop's `intervalMs`. */
  baseMs?: number;
  /** Backoff ceiling; defaults to 60_000. */
  maxMs?: number;
}

export interface BridgePollLoopOptions {
  /** Registry key — duplicate starts return the running handle. */
  name: string;
  /** Fixed cadence in ms. Passed through unchanged from each caller. */
  intervalMs: number;
  /** Run the first poll immediately under the same overlap guard. */
  immediate?: boolean;
  poll: () => void | Promise<unknown>;
  onError?: (error: unknown) => void;
  /**
   * Opt-in exponential backoff between ticks after failures.
   * Default `false` = historical fixed-interval behavior (all current
   * callers); enabled only where a caller explicitly opts in.
   */
  backoff?: BridgePollBackoff | false;
}

export interface BridgePollLoopHandle {
  readonly name: string;
  readonly intervalMs: number;
  readonly running: boolean;
  stop: () => void;
}

interface PollLoopRecord {
  handle: BridgePollLoopHandle;
  timer: NodeJS.Timeout;
}

const pollLoopRegistry = new Map<string, PollLoopRecord>();

function reportHookFailure(name: string, hookError: unknown): void {
  logger.warn(
    `[${name}] poll error hook failed: ${
      hookError instanceof Error ? hookError.message : String(hookError)
    }`
  );
}

/**
 * Start a fixed-cadence poll loop. Returns the running handle; calling again
 * with the same `name` while it runs returns the existing handle.
 */
export function startBridgePollLoop(options: BridgePollLoopOptions): BridgePollLoopHandle {
  const existing = pollLoopRegistry.get(options.name);
  if (existing && existing.handle.running) {
    logger.warn(`[${options.name}] poll loop already running — ignoring duplicate start.`);
    return existing.handle;
  }

  let running = true;
  let inFlight = false;
  let consecutiveFailures = 0;
  let backoffUntil = 0;

  const fire = (): void => {
    if (!running || inFlight) return;
    if (options.backoff && Date.now() < backoffUntil) return;
    inFlight = true;
    void Promise.resolve()
      .then(() => options.poll())
      .then(
        () => {
          consecutiveFailures = 0;
        },
        (error: unknown) => {
          consecutiveFailures += 1;
          if (options.backoff) {
            const baseMs = options.backoff.baseMs ?? options.intervalMs;
            const maxMs = options.backoff.maxMs ?? 60_000;
            const delay = Math.min(baseMs * 2 ** (consecutiveFailures - 1), maxMs);
            backoffUntil = Date.now() + delay;
          }
          try {
            options.onError?.(error);
          } catch (hookError) {
            reportHookFailure(options.name, hookError);
          }
        }
      )
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(fire, options.intervalMs);
  timer.unref?.();

  const handle: BridgePollLoopHandle = {
    name: options.name,
    intervalMs: options.intervalMs,
    get running() {
      return running;
    },
    stop: () => {
      if (!running) return;
      running = false;
      clearInterval(timer);
      const current = pollLoopRegistry.get(options.name);
      if (current && current.handle === handle) pollLoopRegistry.delete(options.name);
    },
  };
  pollLoopRegistry.set(options.name, { handle, timer });
  if (options.immediate) fire();
  return handle;
}

/** Stop a named interval loop. Returns true when a running loop was stopped. */
export function stopBridgePollLoop(name: string): boolean {
  const record = pollLoopRegistry.get(name);
  if (!record || !record.handle.running) return false;
  record.handle.stop();
  return true;
}

/** Stop every tracked interval loop. Returns the stopped names. */
export function stopAllBridgePollLoops(): string[] {
  const stopped: string[] = [];
  for (const [name, record] of pollLoopRegistry.entries()) {
    if (record.handle.running) {
      record.handle.stop();
      stopped.push(name);
    }
  }
  return stopped;
}

export interface BridgeSequentialPollOptions {
  /** Registry key — duplicate starts return the running handle. */
  name: string;
  /**
   * One long-poll iteration. On success the next iteration starts
   * immediately (no added delay); on failure `onError` runs and the loop
   * waits `errorDelayMs` before retrying — the telegram polling contract.
   */
  poll: () => Promise<unknown>;
  onError?: (error: unknown) => void;
  /** Wait after a failed iteration; default 5000 (current telegram behavior). */
  errorDelayMs?: number;
}

export interface BridgeSequentialPollHandle {
  readonly name: string;
  readonly running: boolean;
  /** Resolves when the loop stops. */
  readonly done: Promise<void>;
  stop: () => void;
}

const sequentialPollRegistry = new Map<string, BridgeSequentialPollHandle>();

/**
 * Start a sequential long-poll loop (telegram `getUpdates` shape). The sleep
 * timer stays ref'd so a daemon awaiting `done` keeps the process alive —
 * same as the previous hand-written `while (true)` loop.
 */
export function startBridgeSequentialPoll(
  options: BridgeSequentialPollOptions
): BridgeSequentialPollHandle {
  const existing = sequentialPollRegistry.get(options.name);
  if (existing && existing.running) {
    logger.warn(`[${options.name}] sequential poll already running — ignoring duplicate start.`);
    return existing;
  }

  const errorDelayMs = options.errorDelayMs ?? 5000;
  let running = true;
  let wakeSleep: (() => void) | undefined;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = undefined;
        resolve();
      }, ms);
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = undefined;
        resolve();
      };
    });

  const handle: BridgeSequentialPollHandle = {
    name: options.name,
    get running() {
      return running;
    },
    done,
    stop: () => {
      if (!running) return;
      running = false;
      wakeSleep?.();
    },
  };

  void (async () => {
    while (running) {
      try {
        await options.poll();
      } catch (error) {
        try {
          options.onError?.(error);
        } catch (hookError) {
          reportHookFailure(options.name, hookError);
        }
        if (!running) break;
        await sleep(errorDelayMs);
      }
    }
    resolveDone?.();
    const current = sequentialPollRegistry.get(options.name);
    if (current === handle) sequentialPollRegistry.delete(options.name);
  })();

  sequentialPollRegistry.set(options.name, handle);
  return handle;
}

/**
 * Typing-indicator guard shared by the text bridges. Thin delegation to the
 * core loop — cadence and warn-once cosmetic-failure semantics unchanged.
 */
export function startBridgeTypingIndicator(
  surface: string,
  send: () => unknown,
  intervalMs = 4000
): { stop: () => void } {
  return startBridgeTypingLoop(surface, send, intervalMs);
}

/**
 * Working-note guard for surfaces without a typing API (iMessage). Thin
 * delegation — the 5s one-shot delay is unchanged.
 */
export function scheduleBridgeWorkingNote(
  surface: string,
  send: () => unknown,
  delayMs = 5000
): { cancel: () => void } {
  return scheduleBridgeProcessingNote(surface, send, delayMs);
}
