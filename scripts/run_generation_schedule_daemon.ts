/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md). safeSpawn is not used yet: its env allowlist would drop the provider credentials the tick child needs (G10 kept raw spawn and added the deadline/error/signal contract instead). */
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { recordDaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import { recordRuntimeHealthSample } from '@agent/core/tool/runtime-health-history';
import { sendOpsAlert } from '@agent/core/ops-alert';
import { spawn, type ChildProcess } from 'node:child_process';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  awaitChildWithDeadline,
  ChildDeadlineError,
  installGracefulShutdown,
  startSerialTickLoop,
} from './lib/daemon-loop.js';

const DEFAULT_INTERVAL_MS = Number(
  getRegisteredEnvText('KYBERION_GENERATION_SCHEDULE_INTERVAL_MS') || 60_000
);
/** A tick may run media generation; the floor keeps slow providers from being cut off. */
const TICK_DEADLINE_FLOOR_MS = 15 * 60_000;
const SHUTDOWN_GRACE_MS = 10_000;
const ROOT_DIR = pathResolver.rootDir();
const SCHEDULE_TICK_ENTRY = pathResolver.rootResolve('dist/scripts/run_generation_schedule.js');
const DAEMON_ID = 'generation-schedule-daemon';

/**
 * G10: hard deadline for one tick child —
 * `KYBERION_GENERATION_SCHEDULE_TICK_TIMEOUT_MS` when set to a positive
 * number, otherwise max(5 × interval, 15 min).
 */
export function resolveTickDeadlineMs(
  intervalMs: number,
  override: string | undefined = getRegisteredEnvText(
    'KYBERION_GENERATION_SCHEDULE_TICK_TIMEOUT_MS'
  )
): number {
  const explicit = Number(override);
  if (override && Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(5 * intervalMs, TICK_DEADLINE_FLOOR_MS);
}

const TICK_DEADLINE_MS = resolveTickDeadlineMs(DEFAULT_INTERVAL_MS);
let currentChild: ChildProcess | null = null;
/** Set before the shutdown forwards the signal: a child killed by it is a cancellation, not a failure. */
let shuttingDown = false;

/**
 * EV-05: this loop previously recorded no heartbeat, so `daemon_watchdog` could
 * not observe it and an outage produced no signal at all. A tick failure now
 * also stops killing the daemon: the loop reports and continues, because
 * exiting on one bad tick was itself an unobserved outage.
 */
async function runTick(): Promise<void> {
  const child = spawn(process.execPath, [SCHEDULE_TICK_ENTRY, '--action', 'tick'], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: 'inherit',
  });
  currentChild = child;
  try {
    await awaitChildWithDeadline(child, {
      label: 'generation schedule daemon tick',
      deadlineMs: TICK_DEADLINE_MS,
    });
  } finally {
    currentChild = null;
  }
}

export interface TickReportDeps {
  runTick: () => Promise<void>;
  isShuttingDown: () => boolean;
  recordHeartbeat: typeof recordDaemonHeartbeat;
  sendAlert: typeof sendOpsAlert;
}

export async function runTickAndReport(
  deps: TickReportDeps = {
    runTick,
    isShuttingDown: () => shuttingDown,
    recordHeartbeat: recordDaemonHeartbeat,
    sendAlert: sendOpsAlert,
  }
): Promise<void> {
  deps.recordHeartbeat(DAEMON_ID, { status: 'running', details: { phase: 'tick' } });
  try {
    await deps.runTick();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (deps.isShuttingDown()) {
      // The shutdown forwarded SIGTERM/SIGINT to this child: an expected
      // cancellation — no error heartbeat, no ops alert (a deploy mid-tick
      // must not page anyone). The stopping heartbeat follows from shutdown.
      logger.info(`[generation-schedule-daemon] tick cancelled by shutdown: ${message}`);
      return;
    }
    const timedOut = err instanceof ChildDeadlineError;
    logger.error(`[generation-schedule-daemon] tick error: ${message}`);
    deps.recordHeartbeat(DAEMON_ID, { status: 'error', details: { error: message } });
    deps.sendAlert({
      severity: 'warning',
      title: timedOut ? 'Generation schedule tick timed out' : 'Generation schedule tick failed',
      context: {
        daemon_id: DAEMON_ID,
        error: message,
        ...(timedOut ? { deadline_ms: TICK_DEADLINE_MS } : {}),
      },
      recommendation: timedOut
        ? 'The tick child was killed at its deadline. Inspect the last generation job for a hung provider call; raise KYBERION_GENERATION_SCHEDULE_TICK_TIMEOUT_MS only if the job is legitimately slow.'
        : 'Inspect the media-generation schedule registry and the last generation job; the daemon keeps ticking.',
      dedupe_key: timedOut ? `${DAEMON_ID}:tick-timeout` : `${DAEMON_ID}:tick-failed`,
    });
  }
}

async function main(_args: string[] = []) {
  recordRuntimeHealthSample({ processName: DAEMON_ID });
  const runtimeHealthSampler = setInterval(
    () => recordRuntimeHealthSample({ processName: DAEMON_ID }),
    60 * 60 * 1000
  );
  runtimeHealthSampler.unref?.();
  recordDaemonHeartbeat(DAEMON_ID, {
    status: 'starting',
    details: { tick_interval_ms: DEFAULT_INTERVAL_MS },
  });

  // Serial loop: the next tick is armed DEFAULT_INTERVAL_MS after the previous
  // one settles (same cadence as the old infinite loop + sleep).
  const loop = startSerialTickLoop({
    intervalMs: DEFAULT_INTERVAL_MS,
    tick: () => runTickAndReport(),
  });
  installGracefulShutdown({
    name: DAEMON_ID,
    shutdown: async (signal) => {
      shuttingDown = true;
      clearInterval(runtimeHealthSampler);
      // Forward the signal so the tick child stops with us instead of being orphaned.
      currentChild?.kill(signal);
      const inFlightTick = await loop.stop(SHUTDOWN_GRACE_MS);
      if (inFlightTick === 'timed_out') currentChild?.kill('SIGKILL');
      recordDaemonHeartbeat(DAEMON_ID, {
        status: 'stopping',
        details: { state: 'stopped', signal, in_flight_tick: inFlightTick },
      });
    },
  });
  await loop.firstTick;
}

const runGenerationScheduleDaemon = defineScript({
  name: 'generation:schedule-daemon',
  flags: [],
  run: async ({ argv }) => {
    try {
      await main(argv);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      recordDaemonHeartbeat(DAEMON_ID, { status: 'error', details: { error: message } });
      sendOpsAlert({
        severity: 'critical',
        title: 'Generation schedule daemon fatal error',
        context: { daemon_id: DAEMON_ID, error: message },
        recommendation: 'Restart the generation schedule daemon unit and inspect its logs.',
        dedupe_key: `${DAEMON_ID}:fatal`,
      });
      throw new ScriptExitError(1, message);
    }
  },
});

if (
  isDirectScript(import.meta.url, 'run_generation_schedule_daemon.ts') ||
  isDirectScript(import.meta.url, 'run_generation_schedule_daemon.js')
) {
  void runGenerationScheduleDaemon();
}
