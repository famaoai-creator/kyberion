/**
 * Host-suspension detector for one dot wake.
 *
 * A wake started during a macOS DarkWake (Power Nap) can see the host sleep
 * again seconds later; the goal driver's wall-clock deadline then fires on the
 * next wake-up and the wake ends `wall_clock_exceeded` although the process
 * never ran. That is not the dot's failure and must not feed the failure
 * circuits.
 *
 * Detection is a timer-gap monitor, not a wall-vs-monotonic clock delta: on
 * Node 24 / darwin `process.hrtime`, `performance.now()` and `os.uptime()` all
 * keep advancing across sleep (libuv reads a continuous clock), so their delta
 * against `Date.now()` stays ~0 after a suspension. A short unref'd interval,
 * however, cannot tick while the process is suspended: every observed gap far
 * larger than the interval is time the process did not run. The pending gap
 * since the last tick is included when sampled, so a deadline that fires
 * before the first post-resume tick is still attributed to the suspension.
 * Synchronous event-loop stalls also widen a gap, which is why only
 * {@link DOT_WAKE_SUSPENSION_THRESHOLD_MS} of unaccounted time counts.
 */

/** Unaccounted time above which a wall-clock overrun is attributed to host suspension. */
export const DOT_WAKE_SUSPENSION_THRESHOLD_MS = 30_000;
/** Tick interval of the gap monitor. */
const SUSPENSION_TICK_MS = 5_000;
/** A gap counts as suspension only beyond tick + this slack (event-loop jitter, GC). */
const SUSPENSION_SLACK_MS = 5_000;

export interface DotWakeSuspensionMonitor {
  /** Milliseconds this wake was not running since the monitor started. */
  suspendedMs(): number;
  stop(): void;
}

export type DotWakeSuspensionMonitorFactory = () => DotWakeSuspensionMonitor;

/** Real monitor; `now` and the interval timer are injectable for tests. */
export function startDotWakeSuspensionMonitor(
  options: {
    now?: () => number;
    tickMs?: number;
    setIntervalFn?: (callback: () => void, ms: number) => { unref?: () => void };
    clearIntervalFn?: (handle: unknown) => void;
  } = {}
): DotWakeSuspensionMonitor {
  // Wall clock on purpose: it advances across sleep on every platform, while a
  // monotonic clock that pauses during sleep (older libuv, CLOCK_UPTIME_RAW)
  // would hide the very gap this monitor measures.
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? SUSPENSION_TICK_MS;
  const unaccountedGap = (gap: number) => (gap > tickMs + SUSPENSION_SLACK_MS ? gap - tickMs : 0);
  let lastTick = now();
  let suspended = 0;
  const handle = (options.setIntervalFn ?? setInterval)(() => {
    const at = now();
    suspended += unaccountedGap(at - lastTick);
    lastTick = at;
  }, tickMs);
  (handle as { unref?: () => void }).unref?.();
  return {
    suspendedMs: () => suspended + unaccountedGap(now() - lastTick),
    stop: () => (options.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout)))(handle),
  };
}
