/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md). safeSpawn is not used yet: its env allowlist would drop the provider credentials the tick child needs (G10 kept raw spawn and added the deadline/error/signal contract instead). */
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { recordDaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import { recordRuntimeHealthSample } from '@agent/core/tool/runtime-health-history';
import { sendOpsAlert } from '@agent/core/ops-alert';
import { spawn, type ChildProcess } from 'node:child_process';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { tryInspectCompilerOutputs } from '@agent/core/build-coordination';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  awaitChildWithDeadline,
  ChildDeadlineError,
  installGracefulShutdown,
  startSerialTickLoop,
} from './lib/daemon/daemon-loop.js';

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
  // stderr is piped (and mirrored to ours) so a failure can say why; stdout
  // stays inherited for the launchd log.
  const child = spawn(process.execPath, [SCHEDULE_TICK_ENTRY, '--action', 'tick'], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ['inherit', 'inherit', 'pipe'],
  });
  currentChild = child;
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  try {
    await awaitChildWithDeadline(child, {
      label: 'generation schedule daemon tick',
      deadlineMs: TICK_DEADLINE_MS,
    });
  } catch (err) {
    if (err instanceof Error && stderrTail.trim()) {
      (err as Error & { stderrTail?: string }).stderrTail = stderrTail.trim();
    }
    throw err;
  } finally {
    currentChild = null;
  }
}

/** Last characters of the tick child's stderr kept for the alert. */
const STDERR_TAIL_CHARS = 1200;

/**
 * The tick entry lives in dist/. While `pnpm build` rewrites dist the module
 * is briefly missing — an expected, self-healing condition, not a tick bug.
 */
export function isDistRebuildFailure(stderrTail: string | undefined): boolean {
  return /Cannot find module '[^']*[\\/]dist[\\/]/.test(stderrTail ?? '');
}

async function compilerOutputsIdle(): Promise<boolean> {
  const inspection = await tryInspectCompilerOutputs(async () => true);
  return 'value' in inspection;
}

export interface TickReportDeps {
  runTick: () => Promise<void>;
  isShuttingDown: () => boolean;
  recordHeartbeat: typeof recordDaemonHeartbeat;
  sendAlert: typeof sendOpsAlert;
  /** False while a build holds the compiler outputs; the tick then waits. */
  compilerOutputsIdle?: () => Promise<boolean>;
}

export async function runTickAndReport(
  deps: TickReportDeps = {
    runTick,
    isShuttingDown: () => shuttingDown,
    recordHeartbeat: recordDaemonHeartbeat,
    sendAlert: sendOpsAlert,
    compilerOutputsIdle,
  }
): Promise<void> {
  if (deps.compilerOutputsIdle && !(await deps.compilerOutputsIdle())) {
    // A build owns dist/: the tick entry may be missing mid-rewrite. Skip this
    // tick (heartbeat stays fresh) instead of failing it.
    deps.recordHeartbeat(DAEMON_ID, { status: 'running', details: { phase: 'deferred_build' } });
    logger.debug(
      '[generation-schedule-daemon] compiler outputs busy — tick deferred | next: next tick | evidence: compiler-outputs'
    );
    return;
  }
  deps.recordHeartbeat(DAEMON_ID, { status: 'running', details: { phase: 'tick' } });
  try {
    await deps.runTick();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const stderrTail: string | undefined = err?.stderrTail;
    if (deps.isShuttingDown()) {
      // The shutdown forwarded SIGTERM/SIGINT to this child: an expected
      // cancellation — no error heartbeat, no ops alert (a deploy mid-tick
      // must not page anyone). The stopping heartbeat follows from shutdown.
      logger.info(`[generation-schedule-daemon] tick cancelled by shutdown: ${message}`);
      return;
    }
    if (isDistRebuildFailure(stderrTail)) {
      // A build started after the idle check and removed the entry mid-spawn.
      logger.warn(
        `[generation-schedule-daemon] tick skipped — dist/ is being rebuilt | next: next tick retries | evidence: ${message}`
      );
      deps.recordHeartbeat(DAEMON_ID, { status: 'running', details: { phase: 'deferred_build' } });
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
        ...(stderrTail ? { stderr_tail: stderrTail } : {}),
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
