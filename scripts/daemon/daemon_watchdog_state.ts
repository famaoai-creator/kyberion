/**
 * Daemon watchdog run state (sleep awareness), split from daemon_watchdog.ts so
 * light readers (run_baseline_check) need not load the watchdog's recovery and
 * mission-admission dependencies.
 */
import * as nodePath from 'node:path';
import { DAEMON_SPECS } from '@agent/core/daemon/specs';
import { pathResolver } from '@agent/core/path-resolver';
import { loadJsonIfPresent } from '@agent/core/foundation';

/** Interval of the resident daemon-watchdog unit (DAEMON_SPECS startIntervalSec). */
export const DAEMON_WATCHDOG_INTERVAL_MS =
  (DAEMON_SPECS['daemon-watchdog']?.startIntervalSec ?? 300) * 1000;
/**
 * Sleep awareness: a previous watchdog run older than this is not "the run
 * before" — the host was asleep (or the unit stopped) in between, so the
 * current run is a grace run and cannot confirm an outage on its own. Daemons
 * need a tick after wake before their heartbeats are fresh again.
 */
export const DAEMON_WATCHDOG_CONFIRM_WINDOW_MS = 2 * DAEMON_WATCHDOG_INTERVAL_MS;
/**
 * Re-page interval for a continuing episode. Keys are per daemon and severity,
 * so a new daemon going down or a warning escalating to critical still pages
 * at once; the same outage re-pages at most hourly instead of every 10 minutes.
 */
export const DAEMON_WATCHDOG_REPAGE_INTERVAL_MS = 60 * 60 * 1000;

/** Last watchdog run, persisted so the next run can confirm an outage. */
export interface DaemonWatchdogRunState {
  timestamp: string;
  /** daemon_id -> non-healthy status observed on that run. */
  unhealthy: Record<string, string>;
  /**
   * Daemons that run itself confirmed as an outage (unhealthy on it and on the
   * run before). A first sighting is in `unhealthy` but not here.
   */
  confirmed?: string[];
}

/**
 * Durable state lives next to the heartbeats it summarizes (a subdirectory, so
 * listDaemonHeartbeatStatuses never reads it as a heartbeat) — inside the
 * daemon_watchdog role's existing `active/shared/runtime/heartbeats/` scope.
 */
export function daemonWatchdogRunStatePath(rootDir?: string): string {
  return nodePath.join(
    rootDir ?? pathResolver.shared('runtime/heartbeats'),
    'watchdog-runs',
    'last-run.json'
  );
}

/**
 * True when `daemonId` was already unhealthy on the previous run and that run
 * was recent enough to be the immediately preceding one (no sleep gap).
 */
export function isConfirmedOutage(
  daemonId: string,
  previous: DaemonWatchdogRunState | null,
  now: Date
): boolean {
  if (!previous || !previous.unhealthy[daemonId]) return false;
  const gap = now.getTime() - Date.parse(previous.timestamp);
  return Number.isFinite(gap) && gap >= 0 && gap < DAEMON_WATCHDOG_CONFIRM_WINDOW_MS;
}

/** Read the last watchdog run without changing authority; null when absent or unreadable. */
export function readDaemonWatchdogRunState(rootDir?: string): DaemonWatchdogRunState | null {
  try {
    const raw = loadJsonIfPresent<DaemonWatchdogRunState>(daemonWatchdogRunStatePath(rootDir));
    if (!raw || typeof raw.timestamp !== 'string' || typeof raw.unhealthy !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Whether a second observer (run_baseline_check) may page critical for
 * `daemonId`: true when the watchdog's own recent run also saw it unhealthy,
 * or when there is no watchdog state at all (the watchdog is not running, so
 * nothing else will page). A stale previous run (host just woke) or a recent
 * run that saw the daemon healthy means "not yet confirmed".
 */
export function watchdogConfirmsOutage(
  daemonId: string,
  state: DaemonWatchdogRunState | null,
  now: Date
): boolean {
  if (!state) return true;
  // The watchdog's own latest run must have confirmed it — a first sighting
  // recorded seconds earlier (grace run after wake) is not confirmation.
  if (!state.confirmed?.includes(daemonId)) return false;
  const age = now.getTime() - Date.parse(state.timestamp);
  return Number.isFinite(age) && age >= 0 && age < DAEMON_WATCHDOG_CONFIRM_WINDOW_MS;
}
