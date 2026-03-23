import * as net from 'node:net';
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
  refreshAgentRuntime,
  restartAgentRuntime,
  rootDir,
  runtimeSupervisor,
  safeExistsSync,
  safeMkdir,
  safeUnlinkSync,
  stopAgentRuntime,
} from '@agent/core';

type SupervisorMethod = 'health' | 'ensure' | 'ask' | 'status' | 'list' | 'touch' | 'shutdown' | 'refresh' | 'restart';

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
}

const SOCKET_DIR = pathResolver.shared('runtime/agent-supervisor');
const SOCKET_PATH = `${SOCKET_DIR}/agent-runtime-supervisor.sock`;

function toSnapshotResult(agentId: string, snapshot: ReturnType<typeof getAgentRuntimeSnapshot>, lease?: {
  owner_id?: string;
  owner_type?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> | null {
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

function ensureSocketDir(): void {
  if (!safeExistsSync(SOCKET_DIR)) safeMkdir(SOCKET_DIR, { recursive: true });
}

function writeResponse(socket: net.Socket, response: SupervisorResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

async function handleRequest(request: SupervisorRequest): Promise<SupervisorResponse> {
  try {
    switch (request.method) {
      case 'health':
        return {
          id: request.id,
          ok: true,
          result: {
            ok: true,
            pid: process.pid,
            socket_path: SOCKET_PATH,
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
          capabilities: Array.isArray(payload.capabilities) ? payload.capabilities.map(String) : undefined,
          cwd: typeof payload.cwd === 'string' ? payload.cwd : rootDir(),
          parentAgentId: typeof payload.parentAgentId === 'string' ? payload.parentAgentId : undefined,
          missionId: typeof payload.missionId === 'string' ? payload.missionId : undefined,
          trustRequired: typeof payload.trustRequired === 'number' ? payload.trustRequired : undefined,
          requestedBy: String(payload.requestedBy || 'supervisor_daemon'),
          runtimeMetadata: payload.runtimeMetadata && typeof payload.runtimeMetadata === 'object'
            ? payload.runtimeMetadata as Record<string, unknown>
            : undefined,
          runtimeOwnerId: typeof payload.runtimeOwnerId === 'string' ? payload.runtimeOwnerId : undefined,
          runtimeOwnerType: typeof payload.runtimeOwnerType === 'string' ? payload.runtimeOwnerType : undefined,
        });
        const snapshot = getAgentRuntimeSnapshot(handle.agentId, 20);
        const lease = listAgentRuntimeLeaseSummaries().find((entry) => entry.agent_id === handle.agentId);
        return {
          id: request.id,
          ok: true,
          result: toSnapshotResult(handle.agentId, snapshot, lease) || { agent_id: handle.agentId },
        };
      }
      case 'ask': {
        const payload = request.payload || {};
        const text = await askAgentRuntime(
          String(payload.agentId || ''),
          String(payload.prompt || ''),
          String(payload.requestedBy || 'supervisor_daemon'),
        );
        return {
          id: request.id,
          ok: true,
          result: { text },
        };
      }
      case 'status': {
        const payload = request.payload || {};
        const agentId = String(payload.agentId || '');
        const snapshot = getAgentRuntimeSnapshot(agentId, typeof payload.logLimit === 'number' ? payload.logLimit : 20);
        const lease = listAgentRuntimeLeaseSummaries().find((entry) => entry.agent_id === agentId);
        return {
          id: request.id,
          ok: true,
          result: snapshot ? {
            ...toSnapshotResult(agentId, snapshot, lease),
            log: getAgentRuntimeLog(agentId, typeof payload.logLimit === 'number' ? payload.logLimit : 20),
          } : null,
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
            return toSnapshotResult(snapshot.agent.agentId, snapshot, lease) || {
              agent_id: snapshot.agent.agentId,
            };
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
          String(payload.requestedBy || 'supervisor_daemon'),
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
          String(payload.requestedBy || 'supervisor_daemon'),
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
          String(payload.requestedBy || 'supervisor_daemon'),
        );
        const snapshot = getAgentRuntimeSnapshot(handle.agentId, 20);
        const lease = listAgentRuntimeLeaseSummaries().find((entry) => entry.agent_id === handle.agentId);
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

async function main() {
  process.env.MISSION_ROLE ||= 'surface_runtime';
  ensureSocketDir();
  if (safeExistsSync(SOCKET_PATH)) {
    try {
      safeUnlinkSync(SOCKET_PATH);
    } catch (_) {}
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
        const response = await handleRequest(request);
        writeResponse(socket, response);
      } catch (error: any) {
        writeResponse(socket, { id: 'invalid', ok: false, error: error?.message || String(error) });
      }
    });
  });

  server.on('error', (error: any) => {
    logger.error(`[agent-runtime-supervisor-daemon] ${error?.message || error}`);
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    appendSupervisorEvent({
      decision: 'agent_runtime_supervisor_daemon_started',
      pid: process.pid,
      socket_path: SOCKET_PATH,
    });
    logger.info(`[agent-runtime-supervisor-daemon] listening on ${SOCKET_PATH}`);
  });

  const cleanup = () => {
    try {
      if (safeExistsSync(SOCKET_PATH)) safeUnlinkSync(SOCKET_PATH);
    } catch (_) {}
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);
}

main().catch((error: any) => {
  logger.error(error?.message || String(error));
  process.exit(1);
});
