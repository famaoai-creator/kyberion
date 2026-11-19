/**
 * Stale-code detection and self-recycle for the agent-runtime supervisor daemon.
 *
 * Under a service manager nobody sends `terminate` (only supervisor clients
 * do), so a daemon that outlived a rebuild kept serving the old build until a
 * manual kickstart. Between sweeps, with no work in flight and a settled dist,
 * the daemon drains and exits with STALE_CODE_RECYCLE_EXIT_CODE; launchd
 * KeepAlive {SuccessfulExit: false} / systemd Restart=on-failure respawn it
 * onto the new build. A foreground run (no service manager) never
 * self-recycles — a non-zero exit would just stop it.
 *
 * The daemon owns its in-flight state; it reaches this module only through a
 * StaleCodeRecycleHost of getters and callbacks.
 */
import { tryInspectCompilerOutputs } from '@agent/core/build-coordination';
import { appendSupervisorEvent } from '@agent/core/agent/agent-runtime-events';
import {
  listAgentRuntimeSnapshots,
  shutdownAllAgentRuntimes,
} from '@agent/core/agent/agent-runtime-supervisor';
import { computeSupervisorCodeStamp } from '@agent/core/agent/agent-runtime-supervisor-client';
import { recordDaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import { DAEMON_SPECS } from '@agent/core/daemon/specs';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import { runtimeSupervisor } from '@agent/core/tool/runtime-supervisor';
import { armForcedExit } from '../lib/daemon/daemon-loop.js';

export const STALE_CODE_RECYCLE_EXIT_CODE = 75;
/** Hard-exit fallback after a self-recycle's graceful stop. */
const STALE_CODE_RECYCLE_FORCE_EXIT_MS = 30_000;
/** At most one self-recycle per this window (restart-loop guard; survives the restart via the heartbeat). */
export const STALE_CODE_RECYCLE_MIN_INTERVAL_MS = 15 * 60 * 1000;
/** Stale-code drift is warned at most this often. */
const STALE_CODE_WARN_INTERVAL_MS = 60 * 60 * 1000;

export type SupervisingServiceManager = 'launchd' | 'systemd';

/**
 * The service manager that spawned this process, or null for a foreground /
 * client-spawned run. launchd sets XPC_SERVICE_NAME to the job label; systemd
 * sets SYSTEMD_EXEC_PID to the unit's main pid (only this process, not a shell
 * that merely inherited a service environment). Not KYBERION_* settings, so
 * read raw and injectable for tests.
 */
export function detectSupervisingServiceManager(
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid
): SupervisingServiceManager | null {
  const label = DAEMON_SPECS['agent-runtime-supervisor'].label;
  const xpc = env.XPC_SERVICE_NAME ?? '';
  if (xpc === label || xpc.startsWith(`${label}.`)) return 'launchd';
  if (env.INVOCATION_ID && env.SYSTEMD_EXEC_PID === String(pid)) return 'systemd';
  return null;
}

/** Operator kill switch: `KYBERION_AGENT_RUNTIME_SUPERVISOR_STALE_CODE_RECYCLE=0` keeps warn-only behavior. */
export function staleCodeSelfRecycleEnabled(value: string | undefined): boolean {
  return !/^(0|false|no|off)$/i.test(String(value ?? '').trim());
}

export interface StaleCodeRecycleInput {
  enabled: boolean;
  serviceManager: SupervisingServiceManager | null;
  /** Stamp of the build this process loaded. */
  loadedStamp: number;
  /** Stamp of the dist on disk, read while holding the compiler-outputs lock; null when a build holds it. */
  distStamp: number | null;
  /** Dist stamp seen at the previous check (settle requirement), or null. */
  previousCandidateStamp: number | null;
  dotSweepInFlight: boolean;
  /** Admitted mutating IPC calls, including runtime creation; legacy field name. */
  inflightAsks: number;
  busyRuntimes: number;
  delegatedWorkers: number;
  nowMs: number;
  lastSelfRecycleAtMs: number | null;
  minIntervalMs: number;
}

export type StaleCodeRecycleDecision =
  | { action: 'none'; reason: 'fresh' | 'disabled' | 'unsupervised' }
  | {
      action: 'wait';
      reason:
        | 'build_running'
        | 'settling'
        | 'recycle_backoff'
        | 'sweep_in_flight'
        | 'asks_in_flight'
        | 'runtimes_busy'
        | 'delegated_workers_running';
    }
  | { action: 'recycle'; distStamp: number };

/** Pure decision: recycle only onto a settled newer dist, between sweeps, with nothing in flight. */
export function decideStaleCodeRecycle(input: StaleCodeRecycleInput): StaleCodeRecycleDecision {
  if (!input.enabled) return { action: 'none', reason: 'disabled' };
  if (input.serviceManager === null) return { action: 'none', reason: 'unsupervised' };
  if (input.distStamp === null) return { action: 'wait', reason: 'build_running' };
  if (input.distStamp === 0 || input.loadedStamp === 0 || input.distStamp === input.loadedStamp)
    return { action: 'none', reason: 'fresh' };
  if (input.previousCandidateStamp !== input.distStamp)
    return { action: 'wait', reason: 'settling' };
  if (
    input.lastSelfRecycleAtMs !== null &&
    input.nowMs - input.lastSelfRecycleAtMs < input.minIntervalMs
  )
    return { action: 'wait', reason: 'recycle_backoff' };
  if (input.dotSweepInFlight) return { action: 'wait', reason: 'sweep_in_flight' };
  if (input.inflightAsks > 0) return { action: 'wait', reason: 'asks_in_flight' };
  if (input.busyRuntimes > 0) return { action: 'wait', reason: 'runtimes_busy' };
  if (input.delegatedWorkers > 0) return { action: 'wait', reason: 'delegated_workers_running' };
  return { action: 'recycle', distStamp: input.distStamp };
}

let staleCodeCandidateStamp: number | null = null;
let staleCodeSelfRecycling = false;
/** Last self-recycle time, carried across the restart in the heartbeat's `last_self_recycle_at`. */
let lastSelfRecycleAtMs: number | null = null;
let lastStaleCodeWarnAt = 0;

/** True once a self-recycle has committed (no further sweeps start). */
export function isStaleCodeSelfRecycling(): boolean {
  return staleCodeSelfRecycling;
}

export function selfRecycleHeartbeatDetails(): Record<string, unknown> {
  return lastSelfRecycleAtMs === null
    ? {}
    : { last_self_recycle_at: new Date(lastSelfRecycleAtMs).toISOString() };
}

/** Adopt the previous incarnation's recycle time so the backoff spans restarts; returns the details to carry. */
export function adoptLastSelfRecycleAt(
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const parsed = Date.parse(String(details?.last_self_recycle_at ?? ''));
  if (Number.isFinite(parsed)) lastSelfRecycleAtMs = parsed;
  return lastSelfRecycleAtMs === null ? undefined : selfRecycleHeartbeatDetails();
}

/** Heartbeat details for code-stamp drift (warned at most hourly) and the last self-recycle. */
export function staleCodeHeartbeatDetails(
  loadedStamp: number,
  nowMs: number
): Record<string, unknown> {
  const currentStamp = computeSupervisorCodeStamp();
  const stale = currentStamp !== 0 && loadedStamp !== 0 && currentStamp !== loadedStamp;
  if (stale && nowMs - lastStaleCodeWarnAt >= STALE_CODE_WARN_INTERVAL_MS) {
    lastStaleCodeWarnAt = nowMs;
    logger.warn(
      `[dot-sweep] supervisor runs stale code — core dist changed since start (${loadedStamp} → ${currentStamp}) | next: restart the agent-runtime supervisor daemon to load the new build | evidence: libs/core/dist/index.js`
    );
  }
  return {
    ...(stale ? { stale_code: true, code_stamp: loadedStamp, dist_stamp: currentStamp } : {}),
    ...selfRecycleHeartbeatDetails(),
  };
}

/** Test-only: reset stale-code module state. */
export function resetStaleCodeRecycleStateForTests(): void {
  staleCodeCandidateStamp = null;
  staleCodeSelfRecycling = false;
  lastSelfRecycleAtMs = null;
  lastStaleCodeWarnAt = 0;
}

/** Daemon-owned state and effects the recycle check reads or triggers. */
export interface StaleCodeRecycleHost {
  loadedStamp: number;
  dotSweepInFlight: () => boolean;
  /** All admitted mutating IPC calls, even before a runtime is published. */
  inflightAsks: () => number;
  /** Delegated workers still starting (not yet visible in the runtime supervisor). */
  pendingDelegatedWorkerStarts: () => number;
  /** Called once the recycle commits: stop restarting delegated workers. */
  stopDelegatedWorkers: () => void;
  /** Graceful daemon stop with the given exit code. */
  requestShutdown: (exitCode: number) => void;
}

export interface StaleCodeSelfRecycleDeps {
  enabled?: boolean;
  serviceManager?: SupervisingServiceManager | null;
  loadedStamp?: number;
  computeStamp?: () => number;
  now?: () => number;
  busyRuntimes?: () => number;
  delegatedWorkers?: () => number;
  minIntervalMs?: number;
  drain?: () => Promise<void>;
  exit?: (exitCode: number) => void;
}

function countBusyAgentRuntimes(): number {
  return listAgentRuntimeSnapshots().filter(
    (snapshot) => snapshot.agent.status === 'busy' || snapshot.agent.status === 'booting'
  ).length;
}

function countRunningDelegatedWorkers(host: StaleCodeRecycleHost): number {
  return (
    runtimeSupervisor
      .snapshot()
      .filter((entry) => entry.ownerType === 'delegated-task-worker' && entry.state === 'running')
      .length + host.pendingDelegatedWorkerStarts()
  );
}

/**
 * One self-recycle check (run on the heartbeat cadence). The dist stamp and
 * every in-flight count are read while holding the compiler-outputs lock, and
 * the recycle is committed in that same synchronous step so no sweep can
 * start between the decision and the drain.
 */
export async function runStaleCodeSelfRecycleCheck(
  host: StaleCodeRecycleHost,
  deps: StaleCodeSelfRecycleDeps = {}
): Promise<StaleCodeRecycleDecision> {
  if (staleCodeSelfRecycling) return { action: 'wait', reason: 'sweep_in_flight' };
  const now = deps.now ?? Date.now;
  const loadedStamp = deps.loadedStamp ?? host.loadedStamp;
  const inspection = await tryInspectCompilerOutputs(async () => {
    const distStamp = (deps.computeStamp ?? computeSupervisorCodeStamp)();
    const decision = decideStaleCodeRecycle({
      enabled:
        deps.enabled ??
        staleCodeSelfRecycleEnabled(
          getRegisteredEnvText('KYBERION_AGENT_RUNTIME_SUPERVISOR_STALE_CODE_RECYCLE')
        ),
      serviceManager:
        deps.serviceManager !== undefined ? deps.serviceManager : detectSupervisingServiceManager(),
      loadedStamp,
      distStamp,
      previousCandidateStamp: staleCodeCandidateStamp,
      dotSweepInFlight: host.dotSweepInFlight() || staleCodeSelfRecycling,
      inflightAsks: host.inflightAsks(),
      busyRuntimes: (deps.busyRuntimes ?? countBusyAgentRuntimes)(),
      delegatedWorkers: (deps.delegatedWorkers ?? (() => countRunningDelegatedWorkers(host)))(),
      nowMs: now(),
      lastSelfRecycleAtMs,
      minIntervalMs: deps.minIntervalMs ?? STALE_CODE_RECYCLE_MIN_INTERVAL_MS,
    });
    staleCodeCandidateStamp = distStamp !== 0 && distStamp !== loadedStamp ? distStamp : null;
    if (decision.action === 'recycle') staleCodeSelfRecycling = true;
    return decision;
  });
  if (!('value' in inspection)) {
    // A build owns the outputs: whatever was on disk before is not settled.
    staleCodeCandidateStamp = null;
    return { action: 'wait', reason: 'build_running' };
  }
  const decision = inspection.value;
  if (decision.action !== 'recycle') return decision;

  lastSelfRecycleAtMs = now();
  logger.warn(
    `[agent-runtime-supervisor-daemon] stale code — core dist changed since start (${loadedStamp} → ${decision.distStamp}); self-recycling with exit ${STALE_CODE_RECYCLE_EXIT_CODE} | next: the service manager respawns the daemon on the new build | evidence: libs/core/dist/index.js`
  );
  host.stopDelegatedWorkers();
  appendSupervisorEvent({
    decision: 'agent_runtime_supervisor_daemon_stopping',
    pid: process.pid,
    reason: 'stale_code_self_recycle',
    code_stamp: loadedStamp,
    dist_stamp: decision.distStamp,
  });
  recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
    status: 'stopping',
    details: {
      reason: 'stale_code_self_recycle',
      code_stamp: loadedStamp,
      dist_stamp: decision.distStamp,
      ...selfRecycleHeartbeatDetails(),
    },
  });
  try {
    await (
      deps.drain ?? (() => shutdownAllAgentRuntimes('supervisor_daemon_stale_code_recycle'))
    )();
  } catch (_) {
    /* best-effort drain, as on the terminate path */
  }
  (
    deps.exit ??
    ((exitCode: number) => {
      host.requestShutdown(exitCode);
      // Graceful stop only sets the exit code; a surviving handle would leave
      // the daemon listening on nothing and never respawned (nobody else kills
      // it on a self-recycle). Force the exit after a grace period.
      armForcedExit(exitCode, STALE_CODE_RECYCLE_FORCE_EXIT_MS);
    })
  )(STALE_CODE_RECYCLE_EXIT_CODE);
  return decision;
}
