import * as net from 'node:net';
import { parseSafeJsonInput } from './foundation/json.js';
import { isRecord } from './foundation/text.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { spawnManagedProcess } from './managed-process.js';
import { pathResolver, rootDir } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
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
import { parseEventScopeFromRecord, type EventScope, type EventScopeInput } from './event-scope.js';
import { createLogger } from './logger.js';
const logger = createLogger('agent-runtime-supervisor-client');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class SupervisorRemoteError extends Error {
  constructor(
    message: string,
    readonly errorDetail?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SupervisorRemoteError';
  }
}

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
  errorDetail?: Record<string, unknown>;
}

export function normalizeSupervisorResponse<T>(value: unknown): SupervisorResponse<T> {
  if (!isRecord(value)) throw new Error('supervisor response must be a JSON object');
  const id = value.id;
  const ok = value.ok;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('supervisor response.id must be a non-empty string');
  }
  if (typeof ok !== 'boolean') throw new Error('supervisor response.ok must be boolean');

  const error = value.error;
  if (error !== undefined && typeof error !== 'string') {
    throw new Error('supervisor response.error must be a string');
  }
  const errorDetail = value.errorDetail;
  if (errorDetail !== undefined && !isRecord(errorDetail)) {
    throw new Error('supervisor response.errorDetail must be a JSON object');
  }

  return {
    id,
    ok,
    ...(Object.prototype.hasOwnProperty.call(value, 'result') ? { result: value.result as T } : {}),
    ...(typeof error === 'string' ? { error } : {}),
    ...(isRecord(errorDetail) ? { errorDetail } : {}),
  };
}

function recordResult(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function requiredResultString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalResultString(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string`);
  return value;
}

function parseSupervisorHealthResult(value: unknown): AgentRuntimeSupervisorHealth {
  const record = recordResult(value, 'supervisor health result');
  if (record.ok !== true) throw new Error('supervisor health result.ok must be true');
  const pid = record.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('supervisor health result.pid must be a positive integer');
  }
  const socketPath = requiredResultString(record, 'socket_path', 'supervisor health result');
  const codeStamp = record.code_stamp;
  if (
    codeStamp !== undefined &&
    (typeof codeStamp !== 'number' || !Number.isFinite(codeStamp) || codeStamp < 0)
  ) {
    throw new Error('supervisor health result.code_stamp must be a non-negative number');
  }
  return {
    ok: true,
    pid,
    socket_path: socketPath,
    ...(typeof codeStamp === 'number' ? { code_stamp: codeStamp } : {}),
  };
}

function parseSupervisorSnapshot(value: unknown): AgentRuntimeSupervisorSnapshot {
  const record = recordResult(value, 'supervisor snapshot result');
  const snapshot: AgentRuntimeSupervisorSnapshot = {
    agent_id: requiredResultString(record, 'agent_id', 'supervisor snapshot result'),
  };
  const stringFields = ['provider', 'model_id', 'status', 'owner_id', 'owner_type'] as const;
  for (const key of stringFields) {
    const parsed = optionalResultString(record, key, 'supervisor snapshot result');
    if (parsed !== undefined) snapshot[key] = parsed;
  }
  const sessionId = record.session_id;
  if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
    throw new Error('supervisor snapshot result.session_id must be a string or null');
  }
  if (sessionId !== undefined) snapshot.session_id = sessionId as string | null;

  const pid = record.pid;
  if (pid !== undefined && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 0)) {
    throw new Error('supervisor snapshot result.pid must be a non-negative integer');
  }
  if (typeof pid === 'number') snapshot.pid = pid;

  const metadata = record.metadata;
  const metadataRecord =
    metadata === undefined
      ? undefined
      : recordResult(metadata, 'supervisor snapshot result.metadata');
  if (metadataRecord !== undefined) snapshot.metadata = metadataRecord;

  if (record.scope !== undefined) {
    if (!isRecord(record.scope)) throw new Error('supervisor snapshot result.scope is invalid');
    const scope = parseEventScopeFromRecord({ scope: record.scope });
    if (scope.invalid || !scope.scope)
      throw new Error('supervisor snapshot result.scope is invalid');
    snapshot.scope = scope.scope;
  }

  const log = record.log;
  if (log !== undefined) {
    if (!Array.isArray(log) || log.some((entry) => !isRecord(entry))) {
      throw new Error('supervisor snapshot result.log must be an array of JSON objects');
    }
    snapshot.log = log as Array<Record<string, unknown>>;
  }
  return snapshot;
}

function parseSupervisorAskResult(value: unknown): { text: string } {
  const record = recordResult(value, 'supervisor ask result');
  return { text: requiredResultString(record, 'text', 'supervisor ask result') };
}

function parseSupervisorBooleanResult(
  value: unknown,
  key: 'touched' | 'stopped'
): { touched: boolean } | { stopped: boolean } {
  const record = recordResult(value, `supervisor ${key} result`);
  if (typeof record[key] !== 'boolean') {
    throw new Error(`supervisor ${key} result.${key} must be boolean`);
  }
  return { [key]: record[key] } as { touched: boolean } | { stopped: boolean };
}

function parseSupervisorRefreshResult(value: unknown): { refreshed: boolean; reason: string } {
  const record = recordResult(value, 'supervisor refresh result');
  if (typeof record.refreshed !== 'boolean') {
    throw new Error('supervisor refresh result.refreshed must be boolean');
  }
  return {
    refreshed: record.refreshed,
    reason: requiredResultString(record, 'reason', 'supervisor refresh result'),
  };
}

function parseSupervisorTerminateResult(value: unknown): { terminating: boolean } {
  const record = recordResult(value, 'supervisor terminate result');
  if (record.terminating !== true) {
    throw new Error('supervisor terminate result.terminating must be true');
  }
  return { terminating: true };
}

function parseSupervisorDelegatedEnqueueResult(
  value: unknown
): DelegatedTaskSupervisorEnqueueResult {
  const record = recordResult(value, 'supervisor delegated enqueue result');
  const result: DelegatedTaskSupervisorEnqueueResult = {
    delegation_id: requiredResultString(
      record,
      'delegation_id',
      'supervisor delegated enqueue result'
    ),
    entry_id: requiredResultString(record, 'entry_id', 'supervisor delegated enqueue result'),
    resource_id: requiredResultString(record, 'resource_id', 'supervisor delegated enqueue result'),
  };
  if (
    record.pid !== undefined &&
    (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid < 0)
  ) {
    throw new Error('supervisor delegated enqueue result.pid must be a non-negative integer');
  }
  if (typeof record.pid === 'number') result.pid = record.pid;
  return result;
}

export function normalizeSupervisorResult<T>(method: SupervisorMethod, value: unknown): T {
  let result: unknown;
  switch (method) {
    case 'health':
      result = parseSupervisorHealthResult(value);
      break;
    case 'ensure':
    case 'restart':
      result = parseSupervisorSnapshot(value);
      break;
    case 'ask':
      result = parseSupervisorAskResult(value);
      break;
    case 'status':
      result = value === null ? null : parseSupervisorSnapshot(value);
      break;
    case 'list':
      if (!Array.isArray(value)) throw new Error('supervisor list result must be an array');
      result = value.map(parseSupervisorSnapshot);
      break;
    case 'touch':
      result = parseSupervisorBooleanResult(value, 'touched');
      break;
    case 'shutdown':
      result = parseSupervisorBooleanResult(value, 'stopped');
      break;
    case 'refresh':
      result = parseSupervisorRefreshResult(value);
      break;
    case 'terminate':
      result = parseSupervisorTerminateResult(value);
      break;
    case 'delegated_enqueue':
      result = parseSupervisorDelegatedEnqueueResult(value);
      break;
  }
  return result as T;
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
    const distIndex = assertSafeRepositoryPath(`${rootDir()}/libs/core/dist/index.js`);
    return Math.floor(safeStat(distIndex).mtimeMs);
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
  const safeSocketDir = assertSafeRepositoryPath(SOCKET_DIR, { allowMissingLeaf: true });
  if (!safeExistsSync(safeSocketDir)) safeMkdir(safeSocketDir, { recursive: true });
}

function socketPath(): string {
  ensureSocketDir();
  return assertSafeRepositoryPath(SOCKET_PATH, { allowMissingLeaf: true });
}

function spawnLockPath(): string {
  return assertSafeRepositoryPath(SPAWN_LOCK_PATH, { allowMissingLeaf: true });
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
  timeoutMs = HEALTH_TIMEOUT_MS,
  parseResult: (value: unknown) => TResult = (value) => value as TResult
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
        const parsed: unknown = parseSafeJsonInput(line, 'supervisor response');
        const response = normalizeSupervisorResponse<TResult>(parsed);
        if (!response.ok) {
          const err = new SupervisorRemoteError(
            response.error || 'supervisor_request_failed',
            response.errorDetail
          );
          return finish(() => reject(err));
        }
        return finish(() => resolve(parseResult(response.result)));
      } catch (error: unknown) {
        return finish(() =>
          reject(new Error(`invalid_supervisor_response: ${errorMessage(error)}`))
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
        HEALTH_TIMEOUT_MS,
        parseSupervisorHealthResult
      );
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
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
        await sendSupervisorRequest(
          makeRequest('terminate'),
          HEALTH_TIMEOUT_MS,
          parseSupervisorTerminateResult
        );
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
  const safeSpawnLockPath = spawnLockPath();

  // Multi-spawn guard: use atomic file creation as a mutex
  try {
    safeCreateExclusiveFileSync(safeSpawnLockPath, process.pid.toString());
  } catch (err: unknown) {
    // If lock already exists, wait for health or check if it's stale
    try {
      const stats = safeStat(safeSpawnLockPath);
      if (Date.now() - stats.mtimeMs > 15000) {
        // Stale lock detected
        safeUnlinkSync(safeSpawnLockPath);
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
      if (safeExistsSync(safeSpawnLockPath)) safeUnlinkSync(safeSpawnLockPath);
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
    ENSURE_TIMEOUT_MS,
    parseSupervisorSnapshot
  );
}

export async function askAgentRuntimeViaDaemon(
  payload: AgentRuntimeSupervisorAskPayload
): Promise<{ text: string }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<AgentRuntimeSupervisorAskPayload, { text: string }>(
    makeRequest('ask', payload),
    resolveAskTransportTimeout(payload.timeoutMs),
    parseSupervisorAskResult
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
  >(makeRequest('status', { agentId, logLimit }), STATUS_TIMEOUT_MS, (value) =>
    normalizeSupervisorResult<AgentRuntimeSupervisorSnapshot | null>('status', value)
  );
}

export async function listAgentRuntimesViaDaemon(): Promise<AgentRuntimeSupervisorSnapshot[]> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<undefined, AgentRuntimeSupervisorSnapshot[]>(
    makeRequest('list'),
    STATUS_TIMEOUT_MS,
    (value) => normalizeSupervisorResult<AgentRuntimeSupervisorSnapshot[]>('list', value)
  );
}

export async function touchAgentRuntimeViaDaemon(agentId: string): Promise<{ touched: boolean }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<{ agentId: string }, { touched: boolean }>(
    makeRequest('touch', { agentId }),
    STATUS_TIMEOUT_MS,
    (value) => normalizeSupervisorResult<{ touched: boolean }>('touch', value)
  );
}

export async function shutdownAgentRuntimeViaDaemon(
  agentId: string,
  requestedBy: string
): Promise<{ stopped: boolean }> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<{ agentId: string; requestedBy: string }, { stopped: boolean }>(
    makeRequest('shutdown', { agentId, requestedBy }),
    STATUS_TIMEOUT_MS,
    (value) => normalizeSupervisorResult<{ stopped: boolean }>('shutdown', value)
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
  >(
    makeRequest('refresh', { agentId, requestedBy }),
    STATUS_TIMEOUT_MS,
    parseSupervisorRefreshResult
  );
}

export async function restartAgentRuntimeViaDaemon(
  payload: AgentRuntimeSupervisorEnsurePayload
): Promise<AgentRuntimeSupervisorSnapshot> {
  await ensureAgentRuntimeSupervisorDaemon();
  return sendSupervisorRequest<AgentRuntimeSupervisorEnsurePayload, AgentRuntimeSupervisorSnapshot>(
    makeRequest('restart', payload),
    ENSURE_TIMEOUT_MS,
    parseSupervisorSnapshot
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
  >(
    makeRequest('delegated_enqueue', payload),
    ENSURE_TIMEOUT_MS,
    parseSupervisorDelegatedEnqueueResult
  );
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
