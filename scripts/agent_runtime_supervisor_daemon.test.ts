import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  ensureAgentRuntime: vi.fn(),
  askAgentRuntime: vi.fn(),
  getAgentRuntimeSnapshot: vi.fn(),
  getAgentRuntimeLog: vi.fn(),
  listAgentRuntimeLeaseSummaries: vi.fn(),
  listAgentRuntimeSnapshots: vi.fn(),
  refreshAgentRuntime: vi.fn(),
  restartAgentRuntime: vi.fn(),
  stopAgentRuntime: vi.fn(),
  recordDaemonHeartbeat: vi.fn(),
  runtimeSupervisor: {
    touch: vi.fn(),
  },
  sendOpsAlert: vi.fn(),
  appendSupervisorEvent: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<any>('@agent/core');
  return {
    ...actual,
    ensureAgentRuntime: mocks.ensureAgentRuntime,
    askAgentRuntime: mocks.askAgentRuntime,
    getAgentRuntimeSnapshot: mocks.getAgentRuntimeSnapshot,
    getAgentRuntimeLog: mocks.getAgentRuntimeLog,
    listAgentRuntimeLeaseSummaries: mocks.listAgentRuntimeLeaseSummaries,
    listAgentRuntimeSnapshots: mocks.listAgentRuntimeSnapshots,
    refreshAgentRuntime: mocks.refreshAgentRuntime,
    restartAgentRuntime: mocks.restartAgentRuntime,
    stopAgentRuntime: mocks.stopAgentRuntime,
    recordDaemonHeartbeat: mocks.recordDaemonHeartbeat,
    runtimeSupervisor: mocks.runtimeSupervisor,
    sendOpsAlert: mocks.sendOpsAlert,
    appendSupervisorEvent: mocks.appendSupervisorEvent,
    logger: mocks.logger,
  };
});

import { startAgentRuntimeSupervisorDaemon } from './agent_runtime_supervisor_daemon.js';

async function sendRequest(
  socketPath: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newlineIndex)));
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
    socket.once('error', reject);
  });
}

describe('agent_runtime_supervisor_daemon', () => {
  let rootDir: string;
  let socketPath: string;
  let lockPath: string;
  let instance: Awaited<ReturnType<typeof startAgentRuntimeSupervisorDaemon>> | null = null;

  beforeEach(() => {
    // os.tmpdir() on purpose: Unix domain socket paths are capped (~104
    // macOS / 108 Linux). active/shared/tmp under a CI checkout
    // (/home/runner/work/...) pushes the socket path past the limit and the
    // daemon can never listen.
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyb-daemon-'));
    socketPath = path.join(rootDir, 's.sock');
    lockPath = path.join(rootDir, 'lock');
    mocks.ensureAgentRuntime.mockResolvedValue({
      agentId: 'agent-1',
      ask: async () => 'ok',
      shutdown: async () => {},
      getRecord: () => ({ agentId: 'agent-1' }),
    });
    mocks.askAgentRuntime.mockResolvedValue('daemon-ask');
    mocks.getAgentRuntimeSnapshot.mockReturnValue({
      agent: {
        agentId: 'agent-1',
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        status: 'ready',
        sessionId: 'session-1',
      },
      runtime: { pid: 12345 },
      metrics: {
        turnCount: 0,
        errorCount: 0,
        restartCount: 0,
        refreshCount: 0,
        lastPromptChars: 0,
        totalPromptChars: 0,
        lastResponseChars: 0,
        totalResponseChars: 0,
      },
      logs: [],
      supportsSoftRefresh: true,
    });
    mocks.getAgentRuntimeLog.mockReturnValue([{ ts: Date.now(), type: 'info', content: 'log' }]);
    mocks.listAgentRuntimeLeaseSummaries.mockReturnValue([
      {
        agent_id: 'agent-1',
        owner_id: 'mission-1',
        owner_type: 'mission',
        metadata: { foo: 'bar' },
      },
    ]);
    mocks.listAgentRuntimeSnapshots.mockReturnValue([mocks.getAgentRuntimeSnapshot()]);
  });

  afterEach(async () => {
    if (instance) {
      instance.cleanup();
      instance.server.close();
      instance = null;
    }
    if (rootDir) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('serves health/ensure/ask over the IPC socket', async () => {
    instance = await startAgentRuntimeSupervisorDaemon({
      transport: 'unix',
      socketPath,
      lockPath,
      exitOnFatalError: false,
      exitOnExistingHealthyDaemon: false,
    });

    await expect(sendRequest(socketPath, { id: '1', method: 'health' })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, socket_path: socketPath },
    });

    await expect(
      sendRequest(socketPath, {
        id: '2',
        method: 'ensure',
        payload: {
          agentId: 'agent-1',
          provider: 'gemini',
          requestedBy: 'test',
        },
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { agent_id: 'agent-1', provider: 'gemini', status: 'ready' },
    });

    await expect(
      sendRequest(socketPath, {
        id: '3',
        method: 'ask',
        payload: {
          agentId: 'agent-1',
          prompt: 'hello',
          requestedBy: 'test',
        },
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { text: 'daemon-ask' },
    });
  }, 90000);

  it('returns a typed error for malformed JSON requests', async () => {
    instance = await startAgentRuntimeSupervisorDaemon({
      transport: 'unix',
      socketPath,
      lockPath,
      exitOnFatalError: false,
      exitOnExistingHealthyDaemon: false,
    });

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      socket.once('connect', () => {
        socket.write('{not-json}\n');
      });
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) return;
        const response = JSON.parse(buffer.slice(0, newlineIndex));
        try {
          expect(response).toMatchObject({
            ok: false,
            error: expect.stringContaining('JSON'),
          });
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          socket.destroy();
        }
      });
      socket.once('error', reject);
    });
  }, 90000);
});
