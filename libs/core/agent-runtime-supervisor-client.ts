import * as net from 'node:net';
import { getRegisteredEnvText } from './foundation/env.js';
import { spawnManagedProcess } from './managed-process.js';
import { pathResolver, rootDir } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeUnlinkSync,
  safeCreateExclusiveFileSync,
  safeStat,
} from './secure-io.js';
import type { AgentHandle, SpawnOptions } from './agent-lifecycle.js';
import type { AgentRecord } from './agent-registry.js';
import { resolveAgentTrustScore } from './agent-registry.js';
import type { TaskModelHint } from './reasoning-model-routing.js';
import type { EventScope, EventScopeInput } from './event-scope.js';
import { createLogger } from './logger.js';
const logger = createLogger('agent-runtime-supervisor-client');

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

interface SupervisorRequest<T = Record<string, unknown>> {
  id: string;
  method: SupervisorMethod;
  auth_token?: string;
  payload?: T;
}

interface SupervisorResponse<T = Record<string, unknown>> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
  errorDetail?: Record<string, any>;
}

export interface AgentRuntimeSupervisorHealth {
  ok: true;
  pid: number;
  socket_path: string;
  /** mtime of the core dist the daemon loaded at startup — stale-code detection. */
  code_stamp?: number;
}

/**
 * Code stamp for the supervisor runtime: mtime of the built core the daemon
 * serves behavior from. A daemon whose stamp is older than the caller's was
 * started before the last rebuild and must be recycled — a live one observed
 * in production kept serving pre-fix runtimes after several rebuilds.
 */
export function computeSupervisorCodeStamp(): number {
  try {
    return Math.floor(safeStat(`${rootDir()}/libs/core/dist/index.js`).mtimeMs);
  } catch {
    return 0;
  }
}

export interface AgentRuntimeSupervisorEnsurePayload {
  agentId: string;
  provider: string;
  modelId?: string;
  systemPrompt?: string;
  capabilities?: string[];
  cwd?: string;
  parentAgentId?: string;
  missionId?: string;
  scope?: EventScopeInput;
  trustRequired?: number;
  requestedBy: string;
  runtimeMetadata?: Record<string, unknown>;
  runtimeOwnerId?: string;
  runtimeOwnerType?: string;
}

export interface AgentRuntimeSupervisorSnapshot {
  agent_id: string;
  provider?: string;
  model_id?: string;
  status?: string;
  session_id?: string | null;
  pid?: number;
  owner_id?: string;
  owner_type?: string;
  metadata?: Record<string, unknown>;
  scope?: EventScope;
  /** Runtime daemon may include a bounded log tail in status responses. */
  log?: Array<Record<string, unknown>>;
}

export interface AgentRuntimeSupervisorAskPayload {
  agentId: string;
  prompt: string;
  requestedBy: string;
  missionId?: string;
  scope?: EventScopeInput;
  correlationId?: string;
  /** Transport timeout for this ask; ordinary conversation asks use the default. */
  timeoutMs?: number;
  taskModelHint?: TaskModelHint;
  /**
   * SO-05: declared reasoning tier for this ask (fast/standard/deep).
   * Optional and tolerant on both ends — an old daemon build ignores the
   * field (extra JSON property), and a new daemon build accepts requests
   * from an old client that omits it. No protocol version bump needed.
   */
  model_tier?: 'fast' | 'standard' | 'deep';
}

export interface DelegatedTaskSupervisorEnqueuePayload {
  delegationId: string;
  owner: string;
  text: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface DelegatedTaskSupervisorEnqueueResult {
  delegation_id: string;
  entry_id: string;
  resource_id: string;
  pid?: number;
}

const SOCKET_DIR = pathResolver.shared('runtime/agent-supervisor');
const SOCKET_PATH = `${SOCKET_DIR}/agent-runtime-supervisor.sock`;
const SPAWN_LOCK_PATH = `${SOCKET_DIR}/agent-supervisor-spawn.lock`;
const START_TIMEOUT_MS = 12_000;
const HEALTH_TIMEOUT_MS = 4_000;
const ENSURE_TIMEOUT_MS = 30_000;
const ASK_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;
const ASK_TRANSPORT_GRACE_MS = 5_000;

/**
 * Keep the supervisor socket open for the whole task budget. The runtime
 * itself enforces timeoutMs, so a shorter transport timeout would turn a
 * healthy long-running task into a misleading "not found or not ready"
 * in-process fallback in the A2A bridge.
 */
export function resolveAskTransportTimeout(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0) {
    return ASK_TIMEOUT_MS;
  }
  return Math.max(ASK_TIMEOUT_MS, Math.ceil(timeoutMs) + ASK_TRANSPORT_GRACE_MS);
}

function ensureSocketDir(): void {
  if (!safeExistsSync(SOCKET_DIR)) safeMkdir(SOCKET_DIR, { recursive: true });
}

function socketPath(): string {
  ensureSocketDir();
  return SOCKET_PATH;
}

function makeRequest<T>(method: SupervisorMethod, payload?: T): SupervisorRequest<T> {
  return {
    id: `${method}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    method,
    ...(getRegisteredEnvText('KYBERION_AGENT_RUNTIME_SUPERVISOR_TOKEN')
      ? { auth_token: getRegisteredEnvText('KYBERION_AGENT_RUNTIME_SUPERVISOR_TOKEN') }
      : {}),
    payload,
  };
}

async function sendSupervisorRequest<TPayload, TResult>(
  request: SupervisorRequest<TPayload>,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<TResult> {
  const targetSocket = socketPath();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(targetSocket);
    let buffer = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) return;
      try {
        const response = JSON.parse(line) as SupervisorResponse<TResult>;
        if (!response.ok) {
          const err = new Error(response.error || 'supervisor_request_failed');
          if (response.errorDetail) {
            (err as any).errorDetail = response.errorDetail;
          }
          return finish(() => reject(err));
        }
        return finish(() => resolve(response.result as TResult));
      } catch (error: any) {
        return finish(() =>
          reject(new Error(`invalid_supervisor_response: ${error?.message || error}`))
        );
      }
    });
    socket.once('timeout', () => finish(() => reject(new Error('supervisor_request_timeout'))));
    socket.once('error', (error) => finish(() => reject(error)));
  });
}

async function waitForSupervisorHealth(
  timeoutMs = START_TIMEOUT_MS
): Promise<AgentRuntimeSupervisorHealth> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await sendSupervisorRequest<undefined, AgentRuntimeSupervisorHealth>(
        makeRequest('health'),
        HEALTH_TIMEOUT_MS
      );
    } catch (error: any) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('agent_runtime_supervisor_not_available');
}

export async function ensureAgentRuntimeSupervisorDaemon(): Promise<AgentRuntimeSupervisorHealth> {
  try {
    const health = await waitForSupervisorHealth(750);
    const currentStamp = computeSupervisorCodeStamp();
    const daemonStamp = Number(health.code_stamp || 0);
    if (currentStamp > 0 && daemonStamp > 0 && daemonStamp < currentStamp) {
      logger.info(
        `[supervisor-client] daemon pid=${health.pid} runs stale code (stamp ${daemonStamp} < ${currentStamp}); terminating it for a fresh spawn.`
      );
      try {
        await sendSupervisorRequest(makeRequest('terminate'), HEALTH_TIMEOUT_MS);
      } catch (_) {
        /* daemon may exit before replying — the spawn flow below recovers */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      // fall through to the spawn flow
    } else {
      return health;
    }
  } catch (err) {
    logger.warn(`suppressed error in ensureAgentRuntimeSupervisorDaemon: ${err}`);
  }

  ensureSocketDir();

  // Multi-spawn guard: use atomic file creation as a mutex
  try {
    safeCreateExclusiveFileSync(SPAWN_LOCK_PATH, process.pid.toString());
  } catch (err: any) {
    // If lock already exists, wait for health or check if it's stale
    try {
      const stats = safeStat(SPAWN_LOCK_PATH);
      if (Date.now() - stats.mtimeMs > 15000) {
        // Stale lock detected
        safeUnlinkSync(SPAWN_LOCK_PATH);
        return ensureAgentRuntimeSupervisorDaemon();
      }
    } catch (_) {
      /* best-effort cleanup */
    }

    return waitForSupervisorHealth();
  }

  try {
    const targetSocket = socketPath();
    spawnManagedProcess({
      resourceId: 'agent-runtime-supervisor-daemon',
      kind: 'service',
      ownerId: 'agent-runtime-supervisor-daemon',
      ownerType: 'runtime-supervisor',
      command: process.execPath,
      args: ['dist/scripts/agent_runtime_supervisor_daemon.js'],
      spawnOptions: {
        cwd: rootDir(),
        env: process.env,
        detached: true,
        stdio: 'ignore',
      },
      shutdownPolicy: 'detached',
      metadata: {
        socketPath: targetSocket,
      },
    }).child.unref();

    return await waitForSupervisorHealth();
  } finally {
    try {
      if (safeExistsSync(SPAWN_LOCK_PATH)) safeUnlinkSync(SPAWN_LOCK_PATH);
    } catch (_) {
      /* best-effort cleanup */
    }
  }
}

export async function getAgentRuntimeSupervisorHealth(): Promise<AgentRuntimeSupervisorHealth> {
  return ensureAgentRuntimeSupervisorDaemon();
}

export async function ensureAgentRuntimeViaDaemon(
  payload: AgentRuntimeSupervisorEnsurePayload
): Promise<AgentRuntimeSupervisorSnapshot> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<AgentRuntimeSupervisorEnsurePayload, AgentRuntimeSupervisorSnapshot>(
    makeRequest('ensure', payload),
    ENSURE_TIMEOUT_MS
  );
}

export async function askAgentRuntimeViaDaemon(
  payload: AgentRuntimeSupervisorAskPayload
): Promise<{ text: string }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<AgentRuntimeSupervisorAskPayload, { text: string }>(
    makeRequest('ask', payload),
    resolveAskTransportTimeout(payload.timeoutMs)
  );
}

export async function getAgentRuntimeStatusViaDaemon(
  agentId: string,
  logLimit = 20
): Promise<AgentRuntimeSupervisorSnapshot | null> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<
    { agentId: string; logLimit: number },
    AgentRuntimeSupervisorSnapshot | null
  >(makeRequest('status', { agentId, logLimit }), STATUS_TIMEOUT_MS);
}

export async function listAgentRuntimesViaDaemon(): Promise<AgentRuntimeSupervisorSnapshot[]> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<undefined, AgentRuntimeSupervisorSnapshot[]>(
    makeRequest('list'),
    STATUS_TIMEOUT_MS
  );
}

export async function touchAgentRuntimeViaDaemon(agentId: string): Promise<{ touched: boolean }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<{ agentId: string }, { touched: boolean }>(
    makeRequest('touch', { agentId }),
    STATUS_TIMEOUT_MS
  );
}

export async function shutdownAgentRuntimeViaDaemon(
  agentId: string,
  requestedBy: string
): Promise<{ stopped: boolean }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<{ agentId: string; requestedBy: string }, { stopped: boolean }>(
    makeRequest('shutdown', { agentId, requestedBy }),
    STATUS_TIMEOUT_MS
  );
}

export async function refreshAgentRuntimeViaDaemon(
  agentId: string,
  requestedBy: string
): Promise<{ refreshed: boolean; reason: string }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<
    { agentId: string; requestedBy: string },
    { refreshed: boolean; reason: string }
  >(makeRequest('refresh', { agentId, requestedBy }), STATUS_TIMEOUT_MS);
}

export async function restartAgentRuntimeViaDaemon(
  payload: AgentRuntimeSupervisorEnsurePayload
): Promise<AgentRuntimeSupervisorSnapshot> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<AgentRuntimeSupervisorEnsurePayload, AgentRuntimeSupervisorSnapshot>(
    makeRequest('restart', payload),
    ENSURE_TIMEOUT_MS
  );
}

/**
 * DH-12: enqueue a durable child-session input and ask the supervisor daemon
 * to ensure exactly one cold-resume worker process owns the wake path.
 */
export async function enqueueDelegatedTaskViaSupervisor(
  payload: DelegatedTaskSupervisorEnqueuePayload
): Promise<DelegatedTaskSupervisorEnqueueResult> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<
    DelegatedTaskSupervisorEnqueuePayload,
    DelegatedTaskSupervisorEnqueueResult
  >(makeRequest('delegated_enqueue', payload), ENSURE_TIMEOUT_MS);
}

export function createSupervisorBackedAgentHandle(
  agentId: string,
  requestedBy: string,
  snapshot?: AgentRuntimeSupervisorSnapshot
): AgentHandle {
  return {
    agentId,
    ask: async (
      prompt: string,
      options: { timeoutMs?: number; model_tier?: 'fast' | 'standard' | 'deep' } = {}
    ) => {
      const result = await askAgentRuntimeViaDaemon({
        agentId,
        prompt,
        requestedBy,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(snapshot?.scope ? { scope: snapshot.scope } : {}),
        model_tier: options.model_tier,
      });
      return result.text;
    },
    shutdown: async () => {
      await shutdownAgentRuntimeViaDaemon(agentId, requestedBy);
    },
    getRecord: () => {
      const now = Date.now();
      return {
        agentId,
        provider: snapshot?.provider || 'unknown',
        modelId: snapshot?.model_id || 'unknown',
        capabilities: [],
        trustScore: resolveAgentTrustScore(agentId),
        sessionId: snapshot?.session_id || null,
        threadId: agentId,
        status: (snapshot?.status as AgentRecord['status']) || 'ready',
        spawnedAt: now,
        lastActivity: now,
        scope: snapshot?.scope,
      };
    },
  };
}

export function toSupervisorEnsurePayload(
  options: SpawnOptions & {
    requestedBy: string;
    runtimeMetadata?: Record<string, unknown>;
    runtimeOwnerId?: string;
    runtimeOwnerType?: string;
  }
): AgentRuntimeSupervisorEnsurePayload {
  return {
    agentId: options.agentId!,
    provider: options.provider,
    modelId: options.modelId,
    systemPrompt: options.systemPrompt,
    capabilities: options.capabilities,
    cwd: options.cwd,
    parentAgentId: options.parentAgentId,
    missionId: options.missionId,
    scope: options.scope,
    trustRequired: options.trustRequired,
    requestedBy: options.requestedBy,
    runtimeMetadata: options.runtimeMetadata,
    runtimeOwnerId: options.runtimeOwnerId,
    runtimeOwnerType: options.runtimeOwnerType,
  };
}
