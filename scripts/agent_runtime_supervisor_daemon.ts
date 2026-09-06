import * as net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { defineScript, isDirectScript, setProcessExitCode } from './lib/harness.js';
import {
  askAgentRuntime,
  ensureAgentRuntime,
  getAgentRuntimeLog,
  getAgentRuntimeSnapshot,
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
  refreshAgentRuntime,
  restartAgentRuntime,
  shutdownAllAgentRuntimes,
  stopAgentRuntime,
} from '@agent/core/agent-runtime-supervisor';
import {
  enqueueDelegatedTaskInbox,
  hasPendingDelegatedTaskInbox,
  loadDelegatedTaskRecord,
  recordDelegatedTaskActivationFailure,
  spawnDelegatedTaskWorkerProcess,
} from '@agent/core/delegated-task-observability';
import { appendSupervisorEvent } from '@agent/core/agent-runtime-events';
import { recordDaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import { runtimeSupervisor } from '@agent/core/runtime-supervisor';
import { recordRuntimeHealthSample } from '@agent/core/runtime-health-history';
import { sendOpsAlert } from '@agent/core/ops-alert';
import {
  computeSupervisorCodeStamp,
  normalizeSupervisorResponse,
  normalizeSupervisorResult,
} from '@agent/core/agent-runtime-supervisor-client';
import {
  getRegisteredEnvText,
  parseSafeJsonInput,
  readTextFile,
  setRegisteredEnv,
} from '@agent/core/foundation';
import { isRecord } from '@agent/core/foundation/text';
import { logger } from '@agent/core/core';
import { pathResolver, rootDir } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeUnlinkSync,
  safeCreateExclusiveFileSync,
  safeChmodSync,
} from '@agent/core/secure-io';
import type { TaskModelHint } from '@agent/core/reasoning-model-routing';
import { installProcessGuards } from '@agent/core/process-guards';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('agent-runtime-supervisor');

function registeredEnv(name: string): string | undefined {
  return getRegisteredEnvText(name);
}

export function readDaemonLockTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

// OP-04: hourly RSS/heap samples feed the degradation watch's trend
// evaluation (leak / restart-storm detection over a 24h window).
recordRuntimeHealthSample({ processName: 'agent-runtime-supervisor' });
const runtimeHealthSampler = setInterval(
  () => recordRuntimeHealthSample({ processName: 'agent-runtime-supervisor' }),
  60 * 60 * 1000
);
runtimeHealthSampler.unref?.();

// Captured once at startup: the core build this daemon's behavior comes from.
const DAEMON_CODE_STAMP = computeSupervisorCodeStamp();

type SupervisorMethod =
  | 'health'
  | 'ensure'
  | 'ask'
  | 'status'
  | 'list'
  | 'touch'
  | 'shutdown'
  | 'refresh'
  | 'restart'
  | 'delegated_enqueue'
  | 'terminate';

interface SupervisorRequest {
  id: string;
  method: SupervisorMethod;
  auth_token?: string;
  payload?: Record<string, unknown>;
}

interface SupervisorResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown> | Array<Record<string, unknown>> | null;
  error?: string;
  errorDetail?: Record<string, unknown>;
}

const SUPERVISOR_METHODS = [
  'health',
  'ensure',
  'ask',
  'status',
  'list',
  'touch',
  'shutdown',
  'refresh',
  'restart',
  'delegated_enqueue',
  'terminate',
] as const satisfies readonly SupervisorMethod[];

function normalizeSupervisorRequest(value: unknown): SupervisorRequest {
  if (!isRecord(value)) throw new Error('supervisor request must be a JSON object');
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error('supervisor request.id must be a non-empty string');
  }
  if (
    typeof value.method !== 'string' ||
    !(SUPERVISOR_METHODS as readonly string[]).includes(value.method)
  ) {
    throw new Error('supervisor request.method is unsupported');
  }
  if (value.auth_token !== undefined && typeof value.auth_token !== 'string') {
    throw new Error('supervisor request.auth_token must be a string');
  }
  if (value.payload !== undefined && !isRecord(value.payload)) {
    throw new Error('supervisor request.payload must be a JSON object');
  }
  return {
    id: value.id,
    method: value.method as SupervisorMethod,
    ...(typeof value.auth_token === 'string' ? { auth_token: value.auth_token } : {}),
    ...(isRecord(value.payload) ? { payload: value.payload } : {}),
  };
}

const SOCKET_DIR = pathResolver.shared('runtime/agent-supervisor');
const SOCKET_PATH = `${SOCKET_DIR}/agent-runtime-supervisor.sock`;
const DAEMON_LOCK_PATH = `${SOCKET_DIR}/agent-supervisor-daemon.lock`;

const GLOBAL_LIMIT = Number(registeredEnv('KYBERION_GLOBAL_INFLIGHT_LIMIT') || 8);
const AGENT_LIMIT = Number(registeredEnv('KYBERION_AGENT_INFLIGHT_LIMIT') || 2);

let daemonGlobalInflight = 0;
const daemonAgentInflightMap = new Map<string, number>();
const delegatedWorkerStarts = new Map<string, Promise<{ resourceId: string; pid?: number }>>();
const delegatedWorkerRestartCounts = new Map<string, number>();
const MAX_DELEGATED_WORKER_RESTARTS = 3;
let delegatedWorkerShutdown = false;
let requestShutdown: ((exitCode: number) => void) | undefined;

setInterval(
  () => {
    try {
      const agentInflightObj: Record<string, number> = {};
      for (const [k, v] of daemonAgentInflightMap.entries()) {
        if (v > 0) agentInflightObj[k] = v;
      }
      appendSupervisorEvent({
        decision: 'a2a_inflight_metric',
        inflight_total: daemonGlobalInflight,
        inflight_by_agent: agentInflightObj,
      });
    } catch (err) {
      logger.warn(`[agent_runtime_supervisor_daemon] suppressed error in best-effort step: ${err}`);
    }
  },
  Number(registeredEnv('KYBERION_RUNTIME_SWEEP_INTERVAL_MS') || 30_000)
).unref?.();

export interface AgentRuntimeSupervisorDaemonOptions {
  socketPath?: string;
  lockPath?: string;
  transport?: 'unix' | 'tcp';
  host?: string;
  port?: number;
  exitOnFatalError?: boolean;
  exitOnExistingHealthyDaemon?: boolean;
  retryOnAddressInUse?: boolean;
}

export interface AgentRuntimeSupervisorDaemonInstance {
  server: net.Server;
  socketPath: string;
  host?: string;
  port?: number;
  lockPath: string;
  cleanup: () => void;
}

class DaemonExit extends Error {
  constructor(public readonly code: number) {
    super(`agent runtime supervisor exiting with code ${code}`);
    this.name = 'DaemonExit';
  }
}

type TcpListenTarget = { host: string; port: number };
type ListenTarget = string | TcpListenTarget;

function readTaskModelHint(value: unknown): TaskModelHint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const hint = value as Partial<TaskModelHint>;
  if (
    typeof hint.model_id !== 'string' ||
    typeof hint.tier !== 'string' ||
    typeof hint.effort !== 'string' ||
    typeof hint.route_reason !== 'string'
  ) {
    return undefined;
  }
  if (hint.tier !== 'small' && hint.tier !== 'standard' && hint.tier !== 'large') return undefined;
  if (hint.effort !== 'low' && hint.effort !== 'medium' && hint.effort !== 'high') return undefined;
  return {
    model_id: hint.model_id.trim(),
    tier: hint.tier,
    effort: hint.effort,
    route_reason: hint.route_reason,
  };
}

function resolveTransport(options: AgentRuntimeSupervisorDaemonOptions = {}): 'unix' | 'tcp' {
  return (
    options.transport ||
    (registeredEnv('KYBERION_AGENT_RUNTIME_SUPERVISOR_TRANSPORT') as 'unix' | 'tcp' | undefined) ||
    'unix'
  );
}

function resolveSocketPath(options: AgentRuntimeSupervisorDaemonOptions = {}): string {
  return (
    options.socketPath ||
    registeredEnv('KYBERION_AGENT_RUNTIME_SUPERVISOR_SOCKET_PATH') ||
    SOCKET_PATH
  );
}

function resolveLockPath(options: AgentRuntimeSupervisorDaemonOptions = {}): string {
  return (
    options.lockPath ||
    registeredEnv('KYBERION_AGENT_RUNTIME_SUPERVISOR_LOCK_PATH') ||
    DAEMON_LOCK_PATH
  );
}

function resolveListenTarget(
  options: AgentRuntimeSupervisorDaemonOptions,
  socketPath: string
): ListenTarget {
  if (resolveTransport(options) === 'tcp') {
    return {
      host: options.host || registeredEnv('KYBERION_AGENT_RUNTIME_SUPERVISOR_HOST') || '127.0.0.1',
      port: options.port ?? Number(registeredEnv('KYBERION_AGENT_RUNTIME_SUPERVISOR_PORT') || 0),
    };
  }
  return socketPath;
}

function toSnapshotResult(
  agentId: string,
  snapshot: ReturnType<typeof getAgentRuntimeSnapshot>,
  lease?: {
    owner_id?: string;
    owner_type?: string;
    metadata?: Record<string, unknown>;
  }
): Record<string, unknown> | null {
  if (!snapshot) return null;
  return {
    agent_id: agentId,
    provider: snapshot.agent.provider,
    model_id: snapshot.agent.modelId,
    status: snapshot.agent.status,
    session_id: snapshot.agent.sessionId,
    pid: snapshot.runtime?.pid,
    owner_id: lease?.owner_id,
    owner_type: lease?.owner_type,
    metadata: lease?.metadata,
    scope: snapshot.agent.scope,
  };
}

function ensureSocketDir(socketPath: string, transport: 'unix' | 'tcp'): void {
  if (transport === 'tcp') return;
  const socketDir = path.dirname(socketPath);
  if (socketDir && !safeExistsSync(socketDir)) safeMkdir(socketDir, { recursive: true });
}

function writeResponse(socket: net.Socket, response: SupervisorResponse): void {
  // A caller may time out while the provider is still working. The daemon
  // must keep serving other requests when that caller has already closed its
  // IPC socket; writing to it would otherwise surface an uncaught EPIPE.
  if (socket.destroyed || socket.writableEnded || !socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

function supervisorTokenValid(candidate: string | undefined): boolean {
  const configured = registeredEnv('KYBERION_AGENT_RUNTIME_SUPERVISOR_TOKEN');
  if (!configured) return true;
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}

function socketIsLoopback(socket: net.Socket): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress || '');
}

async function ensureDelegatedTaskWorkerProcess(
  delegationId: string,
  owner: string
): Promise<{ resourceId: string; pid?: number }> {
  const resourceId = `delegated-task-worker:${delegationId}`;
  const existing = runtimeSupervisor.get(resourceId);
  if (existing?.state === 'running') {
    return { resourceId, ...(existing.pid !== undefined ? { pid: existing.pid } : {}) };
  }
  const inFlight = delegatedWorkerStarts.get(delegationId);
  if (inFlight) return inFlight;

  const start = Promise.resolve().then(() => {
    const handle = spawnDelegatedTaskWorkerProcess(delegationId, owner);
    watchDelegatedTaskWorkerProcess(delegationId, owner, handle.child);
    return {
      resourceId: handle.resourceId,
      ...(handle.child.pid !== undefined ? { pid: handle.child.pid } : {}),
    };
  });
  delegatedWorkerStarts.set(delegationId, start);
  try {
    return await start;
  } finally {
    if (delegatedWorkerStarts.get(delegationId) === start)
      delegatedWorkerStarts.delete(delegationId);
  }
}

function scheduleDelegatedTaskWorkerRestart(delegationId: string, owner: string): void {
  if (delegatedWorkerShutdown) return;
  const attempt = (delegatedWorkerRestartCounts.get(delegationId) || 0) + 1;
  delegatedWorkerRestartCounts.set(delegationId, attempt);
  if (attempt > MAX_DELEGATED_WORKER_RESTARTS) {
    appendSupervisorEvent({
      decision: 'delegated_task_worker_restart_exhausted',
      delegation_id: delegationId,
      owner,
      attempts: MAX_DELEGATED_WORKER_RESTARTS,
    });
    return;
  }
  const delayMs = Math.min(1000, 100 * 2 ** (attempt - 1));
  const timer = setTimeout(() => {
    if (delegatedWorkerShutdown) return;
    void ensureDelegatedTaskWorkerProcess(delegationId, owner).catch((error) => {
      logger.warn(
        `[agent_runtime_supervisor_daemon] delegated worker restart failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      appendSupervisorEvent({
        decision: 'delegated_task_worker_restart_failed',
        delegation_id: delegationId,
        owner,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, delayMs);
  timer.unref?.();
  appendSupervisorEvent({
    decision: 'delegated_task_worker_restart_scheduled',
    delegation_id: delegationId,
    owner,
    attempt,
    delay_ms: delayMs,
  });
}

function watchDelegatedTaskWorkerProcess(
  delegationId: string,
  owner: string,
  child: import('node:child_process').ChildProcess
): void {
  child.once('exit', (code, signal) => {
    void (async () => {
      if (delegatedWorkerShutdown) return;
      const record = loadDelegatedTaskRecord(delegationId);
      if (!record) return;

      // A successful activation settles its parent snapshot before the worker
      // exits. Never replay a completed child after a normal process exit.
      if ((record.activation_count ?? 0) >= 1) {
        delegatedWorkerRestartCounts.delete(delegationId);
        if (record.activation_status === 'claimed' && record.activation_id) {
          try {
            recordDelegatedTaskActivationFailure(
              delegationId,
              record.activation_id,
              `worker exited before activation settlement (code=${String(code)}, signal=${String(signal)})`
            );
          } catch (error) {
            logger.warn(
              `[agent_runtime_supervisor_daemon] failed to settle crashed delegated worker: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        return;
      }

      let pending = false;
      try {
        pending = await hasPendingDelegatedTaskInbox(delegationId, owner);
      } catch (error) {
        logger.warn(
          `[agent_runtime_supervisor_daemon] delegated worker inbox inspection failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (!pending) {
        delegatedWorkerRestartCounts.delete(delegationId);
        return;
      }
      appendSupervisorEvent({
        decision: 'delegated_task_worker_exited_with_pending_inbox',
        delegation_id: delegationId,
        owner,
        code,
        signal,
      });
      scheduleDelegatedTaskWorkerRestart(delegationId, owner);
    })().catch((error) => {
      logger.warn(
        `[agent_runtime_supervisor_daemon] delegated worker exit recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  });
}

async function handleRequest(
  request: SupervisorRequest,
  socketLabel: string
): Promise<SupervisorResponse> {
  try {
    switch (request.method) {
      case 'health':
        return {
          id: request.id,
          ok: true,
          result: {
            ok: true,
            pid: process.pid,
            socket_path: socketLabel,
            code_stamp: DAEMON_CODE_STAMP,
          },
        };
      case 'terminate': {
        // Stale-code recycle: the client detected a newer core build than the
        // one this daemon loaded. Drain runtimes and exit; the client spawns
        // a fresh daemon against the current dist.
        logger.info(
          '[agent-runtime-supervisor-daemon] terminate requested (stale code stamp); shutting down.'
        );
        delegatedWorkerShutdown = true;
        appendSupervisorEvent({
          decision: 'agent_runtime_supervisor_daemon_stopping',
          pid: process.pid,
          reason: 'stale_code_recycle',
        });
        recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
          status: 'stopping',
          details: { reason: 'stale_code_recycle' },
        });
        setImmediate(async () => {
          try {
            await shutdownAllAgentRuntimes('supervisor_daemon_terminate');
          } catch (_) {
            /* best-effort drain */
          }
          requestShutdown?.(0);
        });
        return {
          id: request.id,
          ok: true,
          result: { terminating: true },
        };
      }
      case 'ensure': {
        const payload = request.payload || {};
        const agentId = String(payload.agentId || '');
        const handle = await ensureAgentRuntime({
          agentId,
          provider: String(payload.provider || ''),
          modelId: typeof payload.modelId === 'string' ? payload.modelId : undefined,
          systemPrompt: typeof payload.systemPrompt === 'string' ? payload.systemPrompt : undefined,
          capabilities: Array.isArray(payload.capabilities)
            ? payload.capabilities.map(String)
            : undefined,
          cwd: typeof payload.cwd === 'string' ? payload.cwd : rootDir(),
          parentAgentId:
            typeof payload.parentAgentId === 'string' ? payload.parentAgentId : undefined,
          missionId: typeof payload.missionId === 'string' ? payload.missionId : undefined,
          scope:
            payload.scope && typeof payload.scope === 'object'
              ? (payload.scope as Record<string, unknown>)
              : undefined,
          trustRequired:
            typeof payload.trustRequired === 'number' ? payload.trustRequired : undefined,
          requestedBy: String(payload.requestedBy || 'supervisor_daemon'),
          runtimeMetadata:
            payload.runtimeMetadata && typeof payload.runtimeMetadata === 'object'
              ? (payload.runtimeMetadata as Record<string, unknown>)
              : undefined,
          runtimeOwnerId:
            typeof payload.runtimeOwnerId === 'string' ? payload.runtimeOwnerId : undefined,
          runtimeOwnerType:
            typeof payload.runtimeOwnerType === 'string' ? payload.runtimeOwnerType : undefined,
        });
        const snapshot = getAgentRuntimeSnapshot(handle.agentId, 20);
        const lease = listAgentRuntimeLeaseSummaries().find(
          (entry) => entry.agent_id === handle.agentId
        );
        return {
          id: request.id,
          ok: true,
          result: toSnapshotResult(handle.agentId, snapshot, lease) || { agent_id: handle.agentId },
        };
      }
      case 'ask': {
        const payload = request.payload || {};
        const agentId = String(payload.agentId || '');
        const currentAgentInflight = daemonAgentInflightMap.get(agentId) || 0;

        if (daemonGlobalInflight >= GLOBAL_LIMIT || currentAgentInflight >= AGENT_LIMIT) {
          return {
            id: request.id,
            ok: false,
            error: `Agent ${agentId} or global capacity is busy. Global: ${daemonGlobalInflight}/${GLOBAL_LIMIT}, Agent: ${currentAgentInflight}/${AGENT_LIMIT}`,
            errorDetail: {
              type: 'busy',
              retry_after_ms: 1000,
            },
          };
        }

        daemonGlobalInflight++;
        daemonAgentInflightMap.set(agentId, currentAgentInflight + 1);

        try {
          const text = await askAgentRuntime(
            agentId,
            String(payload.prompt || ''),
            String(payload.requestedBy || 'supervisor_daemon'),
            {
              timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined,
              correlationId:
                typeof payload.correlationId === 'string' ? payload.correlationId : undefined,
              missionId: typeof payload.missionId === 'string' ? payload.missionId : undefined,
              scope:
                payload.scope && typeof payload.scope === 'object'
                  ? (payload.scope as Record<string, unknown>)
                  : undefined,
              taskModelHint: readTaskModelHint(payload.taskModelHint),
              // SO-05: optional field — tolerant decoding. Older clients that
              // omit model_tier simply get undefined here (no protocol break).
              modelTier:
                payload.model_tier === 'fast' ||
                payload.model_tier === 'standard' ||
                payload.model_tier === 'deep'
                  ? payload.model_tier
                  : undefined,
            }
          );
          return {
            id: request.id,
            ok: true,
            result: { text },
          };
        } finally {
          daemonGlobalInflight = Math.max(0, daemonGlobalInflight - 1);
          daemonAgentInflightMap.set(
            agentId,
            Math.max(0, (daemonAgentInflightMap.get(agentId) || 0) - 1)
          );
        }
      }
      case 'status': {
        const payload = request.payload || {};
        const agentId = String(payload.agentId || '');
        const snapshot = getAgentRuntimeSnapshot(
          agentId,
          typeof payload.logLimit === 'number' ? payload.logLimit : 20
        );
        const lease = listAgentRuntimeLeaseSummaries().find((entry) => entry.agent_id === agentId);
        return {
          id: request.id,
          ok: true,
          result: snapshot
            ? {
                ...toSnapshotResult(agentId, snapshot, lease),
                log: getAgentRuntimeLog(
                  agentId,
                  typeof payload.logLimit === 'number' ? payload.logLimit : 20
                ),
              }
            : null,
        };
      }
      case 'list': {
        const snapshots = listAgentRuntimeSnapshots();
        const leases = listAgentRuntimeLeaseSummaries();
        return {
          id: request.id,
          ok: true,
          result: snapshots.map((snapshot) => {
            const lease = leases.find((entry) => entry.agent_id === snapshot.agent.agentId);
            return (
              toSnapshotResult(snapshot.agent.agentId, snapshot, lease) || {
                agent_id: snapshot.agent.agentId,
              }
            );
          }),
        };
      }
      case 'touch': {
        const payload = request.payload || {};
        const agentId = String(payload.agentId || '');
        runtimeSupervisor.touch(agentId);
        return {
          id: request.id,
          ok: true,
          result: { touched: true },
        };
      }
      case 'shutdown': {
        const payload = request.payload || {};
        await stopAgentRuntime(
          String(payload.agentId || ''),
          String(payload.requestedBy || 'supervisor_daemon')
        );
        return {
          id: request.id,
          ok: true,
          result: { stopped: true },
        };
      }
      case 'refresh': {
        const payload = request.payload || {};
        const result = await refreshAgentRuntime(
          String(payload.agentId || ''),
          String(payload.requestedBy || 'supervisor_daemon')
        );
        return {
          id: request.id,
          ok: true,
          result,
        };
      }
      case 'restart': {
        const payload = request.payload || {};
        const handle = await restartAgentRuntime(
          String(payload.agentId || ''),
          String(payload.requestedBy || 'supervisor_daemon')
        );
        const snapshot = getAgentRuntimeSnapshot(handle.agentId, 20);
        const lease = listAgentRuntimeLeaseSummaries().find(
          (entry) => entry.agent_id === handle.agentId
        );
        return {
          id: request.id,
          ok: true,
          result: toSnapshotResult(handle.agentId, snapshot, lease) || { agent_id: handle.agentId },
        };
      }
      case 'delegated_enqueue': {
        const payload = request.payload || {};
        const delegationId = String(payload.delegationId || '').trim();
        const owner = String(payload.owner || '').trim();
        const text = String(payload.text || '');
        if (!delegationId || !owner || !text.trim()) {
          throw new Error('delegated_enqueue requires delegationId, owner, and text');
        }
        const metadata =
          payload.metadata && typeof payload.metadata === 'object'
            ? Object.fromEntries(
                Object.entries(payload.metadata as Record<string, unknown>)
                  .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
                  .map(([key, value]) => [key, value as string | number | boolean])
              )
            : undefined;
        const entry = await enqueueDelegatedTaskInbox(delegationId, {
          text,
          requestedBy: owner,
          ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
          wake: false,
        });
        const worker = await ensureDelegatedTaskWorkerProcess(delegationId, owner);
        return {
          id: request.id,
          ok: true,
          result: {
            delegation_id: delegationId,
            entry_id: entry.id,
            resource_id: worker.resourceId,
            ...(worker.pid !== undefined ? { pid: worker.pid } : {}),
          },
        };
      }
      default:
        throw new Error(`unsupported_method:${request.method}`);
    }
  } catch (error: any) {
    return {
      id: request.id,
      ok: false,
      error: error?.message || String(error),
    };
  }
}

async function probeDaemonHealth(target: ListenTarget, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket =
      typeof target === 'string'
        ? net.createConnection(target)
        : net.createConnection({ host: target.host, port: target.port });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          id: 'health-probe',
          method: 'health',
          ...(registeredEnv('KYBERION_AGENT_RUNTIME_SUPERVISOR_TOKEN')
            ? { auth_token: registeredEnv('KYBERION_AGENT_RUNTIME_SUPERVISOR_TOKEN') }
            : {}),
        })}\n`
      );
    });
    socket.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (!line) return done(false);
      try {
        const response = normalizeSupervisorResponse<unknown>(
          parseSafeJsonInput(line, 'agent runtime supervisor response')
        );
        if (!response.ok) return done(false);
        normalizeSupervisorResult('health', response.result);
        done(true);
      } catch {
        done(false);
      }
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function startAgentRuntimeSupervisorDaemon(
  options: AgentRuntimeSupervisorDaemonOptions = {}
): Promise<AgentRuntimeSupervisorDaemonInstance> {
  delegatedWorkerShutdown = false;
  delegatedWorkerRestartCounts.clear();
  if (!getRegisteredEnvText('MISSION_ROLE')) {
    setRegisteredEnv('MISSION_ROLE', 'surface_runtime');
  }
  recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
    status: 'starting',
  });
  const transport = resolveTransport(options);
  const socketPath = resolveSocketPath(options);
  const lockPath = resolveLockPath(options);
  ensureSocketDir(socketPath, transport);
  const listenTarget = resolveListenTarget(options, socketPath);
  let socketLabel = transport === 'tcp' ? '' : socketPath;

  // Multi-instance guard: use a PID-based lock file for the daemon's lifetime
  try {
    safeCreateExclusiveFileSync(lockPath, process.pid.toString());
  } catch (err: any) {
    // If lock already exists, try to read the PID
    let pid: number | undefined;
    try {
      const content = readDaemonLockTextFile(lockPath).trim();
      if (content) {
        pid = parseInt(content);
      } else {
        // Lock exists but empty? Wait and retry.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const retryContent = readDaemonLockTextFile(lockPath).trim();
        if (retryContent) pid = parseInt(retryContent);
      }
    } catch (error: any) {
      logger.warn(
        `[agent-runtime-supervisor-daemon] failed to inspect daemon lock: ${error?.message || error}`
      );
    }

    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // Check if process exists
        logger.info(
          `[agent-runtime-supervisor-daemon] another instance (pid ${pid}) is already running. exiting.`
        );
        throw new DaemonExit(0);
      } catch (killErr: any) {
        // EPERM means the process exists but this launcher cannot inspect it
        // (common under a sandbox or across users). Treating that as ESRCH
        // would delete a live daemon's lock and socket, creating a split-brain
        // supervisor whose heartbeat PID changes underneath clients.
        if (killErr?.code === 'EPERM') {
          const message = `daemon lock is held by an existing process (pid ${pid}) but its liveness cannot be inspected`;
          logger.warn(`[agent-runtime-supervisor-daemon] ${message}`);
          if (options.exitOnExistingHealthyDaemon !== false) throw new DaemonExit(0);
          throw new Error(message);
        }
        // Process does not exist, stale lock
        try {
          safeUnlinkSync(lockPath);
        } catch (error: any) {
          logger.warn(
            `[agent-runtime-supervisor-daemon] failed to remove stale lock: ${error?.message || error}`
          );
        }
        try {
          safeCreateExclusiveFileSync(lockPath, process.pid.toString());
        } catch (error: any) {
          logger.warn(
            `[agent-runtime-supervisor-daemon] failed to recreate daemon lock: ${error?.message || error}`
          );
        }
      }
    } else {
      // No valid PID found, assume stale/broken and try to overwrite
      try {
        safeUnlinkSync(lockPath);
      } catch (error: any) {
        logger.warn(
          `[agent-runtime-supervisor-daemon] failed to remove broken lock: ${error?.message || error}`
        );
      }
      try {
        safeCreateExclusiveFileSync(lockPath, process.pid.toString());
      } catch (error: any) {
        logger.warn(
          `[agent-runtime-supervisor-daemon] failed to recreate daemon lock: ${error?.message || error}`
        );
      }
    }
  }

  if (transport === 'unix' && safeExistsSync(socketPath)) {
    const healthy = await probeDaemonHealth(listenTarget);
    if (healthy) {
      const message = `an existing healthy daemon is already bound at ${socketPath}`;
      logger.info(`[agent-runtime-supervisor-daemon] ${message}`);
      if (options.exitOnExistingHealthyDaemon !== false) throw new DaemonExit(0);
      throw new Error(message);
    }
    try {
      safeUnlinkSync(socketPath);
    } catch (error: any) {
      logger.warn(
        `[agent-runtime-supervisor-daemon] failed to remove stale socket before listen: ${error?.message || error}`
      );
    }
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') {
        logger.warn(`[agent-runtime-supervisor-daemon] client socket error: ${error.message}`);
      }
    });
    socket.on('data', async (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        return writeResponse(socket, { id: 'invalid', ok: false, error: 'empty_request' });
      }
      try {
        const request = normalizeSupervisorRequest(
          parseSafeJsonInput(line, 'agent runtime supervisor request')
        );
        if (
          (transport === 'tcp' && !socketIsLoopback(socket)) ||
          !supervisorTokenValid(request.auth_token)
        ) {
          return writeResponse(socket, {
            id: request.id || 'unknown',
            ok: false,
            error: 'unauthorized',
          });
        }
        const response = await handleRequest(request, socketLabel || socketPath);
        writeResponse(socket, response);
      } catch (error: any) {
        writeResponse(socket, { id: 'invalid', ok: false, error: error?.message || String(error) });
      }
    });
  });

  let retriedListen = false;
  server.on('error', (error: any) => {
    if (!retriedListen && error?.code === 'EADDRINUSE') {
      retriedListen = true;
      void (async () => {
        const healthy = await probeDaemonHealth(listenTarget);
        if (healthy) {
          logger.info(
            `[agent-runtime-supervisor-daemon] existing healthy daemon already bound at ${transport === 'tcp' ? `${(listenTarget as net.ListenOptions).host}:${(listenTarget as net.ListenOptions).port}` : socketPath}`
          );
          if (options.exitOnExistingHealthyDaemon !== false) {
            setProcessExitCode(0);
            if (server.listening) server.close();
          }
          return;
        }
        logger.warn(
          `[agent-runtime-supervisor-daemon] socket busy, retrying after stale socket cleanup: ${transport === 'tcp' ? `${(listenTarget as net.ListenOptions).host}:${(listenTarget as net.ListenOptions).port}` : socketPath}`
        );
        try {
          if (transport === 'unix' && safeExistsSync(socketPath)) safeUnlinkSync(socketPath);
          server.listen(listenTarget);
          return;
        } catch (retryError: any) {
          logger.error(
            `[agent-runtime-supervisor-daemon] retry after EADDRINUSE failed: ${retryError?.message || retryError}`
          );
        }
        if (options.exitOnFatalError !== false) {
          setProcessExitCode(1);
          if (server.listening) server.close();
        }
      })();
      return;
    }
    logger.error(`[agent-runtime-supervisor-daemon] ${error?.message || error}`);
    recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
      status: 'error',
      details: { error: error?.message || String(error) },
    });
    try {
      sendOpsAlert({
        severity: 'critical',
        title: 'Agent runtime supervisor daemon error',
        context: {
          daemon_id: 'agent-runtime-supervisor-daemon',
          error: error?.message || String(error),
        },
        recommendation: 'Restart the supervisor daemon and inspect the runtime supervisor log.',
        dedupe_key: 'agent-runtime-supervisor-daemon:error',
      });
    } catch (alertError: any) {
      logger.warn(
        `[agent-runtime-supervisor-daemon] failed to write ops alert: ${alertError?.message || alertError}`
      );
    }
    if (options.exitOnFatalError !== false) {
      setProcessExitCode(1);
      if (server.listening) server.close();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('agent_runtime_supervisor_daemon_start_timeout')),
      60000
    );
    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };
    server.listen(listenTarget, () => {
      try {
        const address = server.address();
        if (transport === 'tcp' && typeof address === 'object' && address) {
          socketLabel = `${address.address}:${address.port}`;
        }
        appendSupervisorEvent({
          decision: 'agent_runtime_supervisor_daemon_started',
          pid: process.pid,
          socket_path: socketLabel || socketPath,
        });
        if (transport === 'unix') safeChmodSync(socketPath, 0o600);
        recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
          status: 'running',
          details: { socket_path: socketLabel || socketPath, transport },
        });
        logger.info(`[agent-runtime-supervisor-daemon] listening on ${socketLabel || socketPath}`);
      } finally {
        finish();
      }
    });
    timeout.unref?.();
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    delegatedWorkerShutdown = true;
    appendSupervisorEvent({
      decision: 'agent_runtime_supervisor_daemon_stopping',
      pid: process.pid,
      reason: 'process_exit',
    });
    recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
      status: 'stopping',
      details: { reason: 'process_exit' },
    });
    // Do not unlink the pathname here. A stale daemon can still receive a
    // signal after a newer daemon has rebound the same path; unlinking from
    // the old process would make the healthy daemon unreachable. Startup
    // already probes health and removes only an unresponsive stale socket.
    try {
      if (safeExistsSync(lockPath)) {
        const currentPid = readDaemonLockTextFile(lockPath).trim();
        if (currentPid === process.pid.toString()) {
          safeUnlinkSync(lockPath);
        }
      }
    } catch (error: any) {
      logger.warn(
        `[agent-runtime-supervisor-daemon] failed to cleanup daemon lock: ${error?.message || error}`
      );
    }
  };
  const stopDaemon = (exitCode: number) => {
    cleanup();
    if (!server.listening) {
      setProcessExitCode(exitCode);
      return;
    }
    const forceExit = setTimeout(() => setProcessExitCode(exitCode), 1500);
    forceExit.unref?.();
    server.close(() => {
      clearTimeout(forceExit);
      setProcessExitCode(exitCode);
    });
  };
  requestShutdown = stopDaemon;
  process.once('SIGINT', () => stopDaemon(130));
  process.once('SIGTERM', () => stopDaemon(143));
  process.once('exit', cleanup);

  const address = server.address();
  return {
    server,
    socketPath: transport === 'tcp' ? '' : socketPath,
    host:
      transport === 'tcp' && typeof address === 'object' && address ? address.address : undefined,
    port: transport === 'tcp' && typeof address === 'object' && address ? address.port : undefined,
    lockPath,
    cleanup,
  };
}

async function main(_args: string[] = []) {
  await startAgentRuntimeSupervisorDaemon();
  setInterval(() => {
    recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
      status: 'running',
    });
  }, 30_000).unref?.();
}

const isDirect =
  isDirectScript(import.meta.url, 'agent_runtime_supervisor_daemon.ts') ||
  isDirectScript(import.meta.url, 'agent_runtime_supervisor_daemon.js');

const runAgentRuntimeSupervisorDaemon = defineScript({
  name: 'agent-runtime:supervisor-daemon',
  flags: [],
  run: async ({ argv }) => {
    try {
      await main(argv);
    } catch (error: any) {
      if (error instanceof DaemonExit) {
        setProcessExitCode(error.code);
        return;
      }
      const message = error?.message || String(error);
      logger.error(message);
      recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
        status: 'error',
        details: { error: message },
      });
      appendSupervisorEvent({
        decision: 'agent_runtime_supervisor_daemon_failed',
        pid: process.pid,
        error: message,
      });
      try {
        sendOpsAlert({
          severity: 'critical',
          title: 'Agent runtime supervisor daemon fatal error',
          context: {
            daemon_id: 'agent-runtime-supervisor-daemon',
            error: message,
          },
          recommendation: 'Restart the supervisor daemon and inspect startup configuration.',
          dedupe_key: 'agent-runtime-supervisor-daemon:fatal',
        });
      } catch (alertError: any) {
        logger.warn(
          `[agent-runtime-supervisor-daemon] failed to write fatal ops alert: ${alertError?.message || alertError}`
        );
      }
      setProcessExitCode(1);
    }
  },
});

if (isDirect) {
  void runAgentRuntimeSupervisorDaemon();
}
