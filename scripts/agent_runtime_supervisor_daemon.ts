import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendSupervisorEvent,
  askAgentRuntime,
  ensureAgentRuntime,
  getAgentRuntimeLog,
  getAgentRuntimeSnapshot,
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
  logger,
  pathResolver,
  recordDaemonHeartbeat,
  refreshAgentRuntime,
  restartAgentRuntime,
  rootDir,
  runtimeSupervisor,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeUnlinkSync,
  safeCreateExclusiveFileSync,
  sendOpsAlert,
  stopAgentRuntime,
} from '@agent/core';
import type { TaskModelHint } from '@agent/core/reasoning-model-routing';
import { installProcessGuards, recordRuntimeHealthSample } from '@agent/core';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('agent-runtime-supervisor');

// OP-04: hourly RSS/heap samples feed the degradation watch's trend
// evaluation (leak / restart-storm detection over a 24h window).
recordRuntimeHealthSample({ processName: 'agent-runtime-supervisor' });
const runtimeHealthSampler = setInterval(
  () => recordRuntimeHealthSample({ processName: 'agent-runtime-supervisor' }),
  60 * 60 * 1000
);
runtimeHealthSampler.unref?.();

type SupervisorMethod =
  | 'health'
  | 'ensure'
  | 'ask'
  | 'status'
  | 'list'
  | 'touch'
  | 'shutdown'
  | 'refresh'
  | 'restart';

interface SupervisorRequest {
  id: string;
  method: SupervisorMethod;
  payload?: Record<string, unknown>;
}

interface SupervisorResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown> | Array<Record<string, unknown>> | null;
  error?: string;
  errorDetail?: Record<string, any>;
}

const SOCKET_DIR = pathResolver.shared('runtime/agent-supervisor');
const SOCKET_PATH = `${SOCKET_DIR}/agent-runtime-supervisor.sock`;
const DAEMON_LOCK_PATH = `${SOCKET_DIR}/agent-supervisor-daemon.lock`;

const GLOBAL_LIMIT = Number(process.env.KYBERION_GLOBAL_INFLIGHT_LIMIT || 8);
const AGENT_LIMIT = Number(process.env.KYBERION_AGENT_INFLIGHT_LIMIT || 2);

let daemonGlobalInflight = 0;
const daemonAgentInflightMap = new Map<string, number>();

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
    } catch (_) {}
  },
  Number(process.env.KYBERION_RUNTIME_SWEEP_INTERVAL_MS || 30_000)
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
    (process.env.KYBERION_AGENT_RUNTIME_SUPERVISOR_TRANSPORT as 'unix' | 'tcp' | undefined) ||
    'unix'
  );
}

function resolveSocketPath(options: AgentRuntimeSupervisorDaemonOptions = {}): string {
  return (
    options.socketPath || process.env.KYBERION_AGENT_RUNTIME_SUPERVISOR_SOCKET_PATH || SOCKET_PATH
  );
}

function resolveLockPath(options: AgentRuntimeSupervisorDaemonOptions = {}): string {
  return (
    options.lockPath || process.env.KYBERION_AGENT_RUNTIME_SUPERVISOR_LOCK_PATH || DAEMON_LOCK_PATH
  );
}

function resolveListenTarget(
  options: AgentRuntimeSupervisorDaemonOptions,
  socketPath: string
): ListenTarget {
  if (resolveTransport(options) === 'tcp') {
    return {
      host: options.host || process.env.KYBERION_AGENT_RUNTIME_SUPERVISOR_HOST || '127.0.0.1',
      port: options.port ?? Number(process.env.KYBERION_AGENT_RUNTIME_SUPERVISOR_PORT || 0),
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
  };
}

function ensureSocketDir(socketPath: string, transport: 'unix' | 'tcp'): void {
  if (transport === 'tcp') return;
  const socketDir = path.dirname(socketPath);
  if (socketDir && !safeExistsSync(socketDir)) safeMkdir(socketDir, { recursive: true });
}

function writeResponse(socket: net.Socket, response: SupervisorResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
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
          },
        };
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
              taskModelHint: readTaskModelHint(payload.taskModelHint),
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
      socket.write(`${JSON.stringify({ id: 'health-probe', method: 'health' })}\n`);
    });
    socket.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (!line) return done(false);
      try {
        const response = JSON.parse(line) as SupervisorResponse;
        done(Boolean(response.ok));
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
  process.env.MISSION_ROLE ||= 'surface_runtime';
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
      const content = String(safeReadFile(lockPath, { encoding: 'utf8' })).trim();
      if (content) {
        pid = parseInt(content);
      } else {
        // Lock exists but empty? Wait and retry.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const retryContent = String(safeReadFile(lockPath, { encoding: 'utf8' })).trim();
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
        process.exit(0);
      } catch (killErr: any) {
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
    socket.on('data', async (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        return writeResponse(socket, { id: 'invalid', ok: false, error: 'empty_request' });
      }
      try {
        const request = JSON.parse(line) as SupervisorRequest;
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
          if (options.exitOnExistingHealthyDaemon !== false) process.exit(0);
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
        if (options.exitOnFatalError !== false) process.exit(1);
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
    if (options.exitOnFatalError !== false) process.exit(1);
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

  const cleanup = () => {
    recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
      status: 'stopping',
    });
    try {
      if (transport === 'unix' && safeExistsSync(socketPath)) safeUnlinkSync(socketPath);
    } catch (error: any) {
      logger.warn(
        `[agent-runtime-supervisor-daemon] failed to cleanup socket: ${error?.message || error}`
      );
    }
    try {
      if (safeExistsSync(lockPath)) {
        const currentPid = String(safeReadFile(lockPath, { encoding: 'utf8' })).trim();
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
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
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

async function main() {
  await startAgentRuntimeSupervisorDaemon();
  setInterval(() => {
    recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
      status: 'running',
    });
  }, 30_000).unref?.();
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error: any) => {
    logger.error(error?.message || String(error));
    recordDaemonHeartbeat('agent-runtime-supervisor-daemon', {
      status: 'error',
      details: { error: error?.message || String(error) },
    });
    sendOpsAlert({
      severity: 'critical',
      title: 'Agent runtime supervisor daemon fatal error',
      context: {
        daemon_id: 'agent-runtime-supervisor-daemon',
        error: error?.message || String(error),
      },
      recommendation: 'Restart the supervisor daemon and inspect startup configuration.',
      dedupe_key: 'agent-runtime-supervisor-daemon:fatal',
    });
    process.exit(1);
  });
}
