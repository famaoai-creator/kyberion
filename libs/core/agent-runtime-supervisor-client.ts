import * as net from 'node:net';
import { spawnManagedProcess } from './managed-process.js';
import { pathResolver, rootDir } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeUnlinkSync, safeCreateExclusiveFileSync, safeStat } from './secure-io.js';
import type { AgentHandle, SpawnOptions } from './agent-lifecycle.js';
import type { AgentRecord } from './agent-registry.js';

type SupervisorMethod = 'health' | 'ensure' | 'ask' | 'status' | 'list' | 'touch' | 'shutdown' | 'refresh' | 'restart';

interface SupervisorRequest<T = Record<string, unknown>> {
  id: string;
  method: SupervisorMethod;
  payload?: T;
}

interface SupervisorResponse<T = Record<string, unknown>> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface AgentRuntimeSupervisorHealth {
  ok: true;
  pid: number;
  socket_path: string;
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
}

export interface AgentRuntimeSupervisorAskPayload {
  agentId: string;
  prompt: string;
  requestedBy: string;
}

const SOCKET_DIR = pathResolver.shared('runtime/agent-supervisor');
const SOCKET_PATH = `${SOCKET_DIR}/agent-runtime-supervisor.sock`;
const SPAWN_LOCK_PATH = `${SOCKET_DIR}/agent-supervisor-spawn.lock`;
const START_TIMEOUT_MS = 12_000;
const HEALTH_TIMEOUT_MS = 4_000;
const ENSURE_TIMEOUT_MS = 30_000;
const ASK_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;

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
    payload,
  };
}

async function sendSupervisorRequest<TPayload, TResult>(
  request: SupervisorRequest<TPayload>,
  timeoutMs = HEALTH_TIMEOUT_MS,
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
          return finish(() => reject(new Error(response.error || 'supervisor_request_failed')));
        }
        return finish(() => resolve(response.result as TResult));
      } catch (error: any) {
        return finish(() => reject(new Error(`invalid_supervisor_response: ${error?.message || error}`)));
      }
    });
    socket.once('timeout', () => finish(() => reject(new Error('supervisor_request_timeout'))));
    socket.once('error', (error) => finish(() => reject(error)));
  });
}

async function waitForSupervisorHealth(timeoutMs = START_TIMEOUT_MS): Promise<AgentRuntimeSupervisorHealth> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await sendSupervisorRequest<undefined, AgentRuntimeSupervisorHealth>(makeRequest('health'), HEALTH_TIMEOUT_MS);
    } catch (error: any) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('agent_runtime_supervisor_not_available');
}

export async function ensureAgentRuntimeSupervisorDaemon(): Promise<AgentRuntimeSupervisorHealth> {
  try {
    return await waitForSupervisorHealth(750);
  } catch (_) {}

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
    } catch (_) {}
    
    return waitForSupervisorHealth();
  }

  try {
    const targetSocket = socketPath();
    spawnManagedProcess({
      resourceId: 'agent-runtime-supervisor-daemon',
      kind: 'service',
      ownerId: 'agent-runtime-supervisor-daemon',
      ownerType: 'runtime-supervisor',
      command: 'node',
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
    } catch (_) {}
  }
}

export async function getAgentRuntimeSupervisorHealth(): Promise<AgentRuntimeSupervisorHealth> {

  return ensureAgentRuntimeSupervisorDaemon();
}

export async function ensureAgentRuntimeViaDaemon(payload: AgentRuntimeSupervisorEnsurePayload): Promise<AgentRuntimeSupervisorSnapshot> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<AgentRuntimeSupervisorEnsurePayload, AgentRuntimeSupervisorSnapshot>(
    makeRequest('ensure', payload),
    ENSURE_TIMEOUT_MS,
  );
}

export async function askAgentRuntimeViaDaemon(payload: AgentRuntimeSupervisorAskPayload): Promise<{ text: string }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<AgentRuntimeSupervisorAskPayload, { text: string }>(
    makeRequest('ask', payload),
    ASK_TIMEOUT_MS,
  );
}

export async function getAgentRuntimeStatusViaDaemon(agentId: string, logLimit = 20): Promise<AgentRuntimeSupervisorSnapshot | null> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<{ agentId: string; logLimit: number }, AgentRuntimeSupervisorSnapshot | null>(
    makeRequest('status', { agentId, logLimit }),
    STATUS_TIMEOUT_MS,
  );
}

export async function listAgentRuntimesViaDaemon(): Promise<AgentRuntimeSupervisorSnapshot[]> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<undefined, AgentRuntimeSupervisorSnapshot[]>(makeRequest('list'), STATUS_TIMEOUT_MS);
}

export async function touchAgentRuntimeViaDaemon(agentId: string): Promise<{ touched: boolean }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<{ agentId: string }, { touched: boolean }>(
    makeRequest('touch', { agentId }),
    STATUS_TIMEOUT_MS,
  );
}

export async function shutdownAgentRuntimeViaDaemon(agentId: string, requestedBy: string): Promise<{ stopped: boolean }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<{ agentId: string; requestedBy: string }, { stopped: boolean }>(
    makeRequest('shutdown', { agentId, requestedBy }),
    STATUS_TIMEOUT_MS,
  );
}

export async function refreshAgentRuntimeViaDaemon(
  agentId: string,
  requestedBy: string,
): Promise<{ refreshed: boolean; reason: string }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<{ agentId: string; requestedBy: string }, { refreshed: boolean; reason: string }>(
    makeRequest('refresh', { agentId, requestedBy }),
    STATUS_TIMEOUT_MS,
  );
}

export async function restartAgentRuntimeViaDaemon(
  payload: AgentRuntimeSupervisorEnsurePayload,
): Promise<AgentRuntimeSupervisorSnapshot> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<AgentRuntimeSupervisorEnsurePayload, AgentRuntimeSupervisorSnapshot>(
    makeRequest('restart', payload),
    ENSURE_TIMEOUT_MS,
  );
}

export function createSupervisorBackedAgentHandle(
  agentId: string,
  requestedBy: string,
  snapshot?: AgentRuntimeSupervisorSnapshot,
): AgentHandle {
  return {
    agentId,
    ask: async (prompt: string) => {
      const result = await askAgentRuntimeViaDaemon({ agentId, prompt, requestedBy });
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
        trustScore: 5,
        sessionId: snapshot?.session_id || null,
        threadId: agentId,
        status: (snapshot?.status as AgentRecord['status']) || 'ready',
        spawnedAt: now,
        lastActivity: now,
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
  },
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
    trustRequired: options.trustRequired,
    requestedBy: options.requestedBy,
    runtimeMetadata: options.runtimeMetadata,
    runtimeOwnerId: options.runtimeOwnerId,
    runtimeOwnerType: options.runtimeOwnerType,
  };
}
