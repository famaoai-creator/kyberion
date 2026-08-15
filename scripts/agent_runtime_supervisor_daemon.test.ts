import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathResolver } from '@agent/core';

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
    // Keep the socket under the governed project temp root so secure-io can
    // enforce the 0600 chmod in the same way production does.
    rootDir = fs.mkdtempSync(pathResolver.sharedTmp('kyb-'));
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

  it('keeps serving after a timed-out client closes before the provider replies', async () => {
    instance = await startAgentRuntimeSupervisorDaemon({
      transport: 'unix',
      socketPath,
      lockPath,
      exitOnFatalError: false,
      exitOnExistingHealthyDaemon: false,
    });

    let resolveAsk!: (value: string) => void;
    mocks.askAgentRuntime.mockImplementation(
      () => new Promise<string>((resolve) => (resolveAsk = resolve))
    );
    const abandoned = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      abandoned.once('connect', async () => {
        abandoned.write(
          `${JSON.stringify({
            id: 'abandoned',
            method: 'ask',
            payload: { agentId: 'agent-1', prompt: 'slow', requestedBy: 'test' },
          })}\n`
        );
        for (let attempt = 0; attempt < 20 && !resolveAsk; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        abandoned.destroy();
        resolve();
      });
      abandoned.once('error', reject);
    });
    expect(resolveAsk).toBeTypeOf('function');
    resolveAsk('late response');

    mocks.askAgentRuntime.mockResolvedValue('healthy response');
    await expect(
      sendRequest(socketPath, {
        id: 'after-abandon',
        method: 'ask',
        payload: { agentId: 'agent-1', prompt: 'healthy', requestedBy: 'test' },
      })
    ).resolves.toMatchObject({ ok: true, result: { text: 'healthy response' } });
  });

  it('creates a private Unix socket', async () => {
    instance = await startAgentRuntimeSupervisorDaemon({
      transport: 'unix',
      socketPath,
      lockPath,
      exitOnFatalError: false,
      exitOnExistingHealthyDaemon: false,
    });

    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('does not replace an existing healthy daemon when a lock is ambiguous', async () => {
    instance = await startAgentRuntimeSupervisorDaemon({
      transport: 'unix',
      socketPath,
      lockPath,
      exitOnFatalError: false,
      exitOnExistingHealthyDaemon: false,
    });

    await expect(
      startAgentRuntimeSupervisorDaemon({
        transport: 'unix',
        socketPath,
        lockPath,
        exitOnFatalError: false,
        exitOnExistingHealthyDaemon: false,
      })
    ).rejects.toThrow(/existing healthy daemon/);
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('rejects ask requests over the per-agent inflight limit and admits again once slots free up', async () => {
    // AGENT_LIMIT defaults to 2 (KYBERION_AGENT_INFLIGHT_LIMIT unset in test env).
    instance = await startAgentRuntimeSupervisorDaemon({
      transport: 'unix',
      socketPath,
      lockPath,
      exitOnFatalError: false,
      exitOnExistingHealthyDaemon: false,
    });

    // Track resolvers in invocation order rather than assuming which of the
    // two concurrent requests below wins the race to be admitted first.
    const resolvers: Array<(value: string) => void> = [];
    mocks.askAgentRuntime.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const askAgent1 = (id: string) =>
      sendRequest(socketPath, {
        id,
        method: 'ask',
        payload: { agentId: 'agent-1', prompt: 'hello', requestedBy: 'test' },
      });

    const pending1 = askAgent1('a');
    const pending2 = askAgent1('b');
    // Give both requests a tick to be admitted and increment inflight before the third arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolvers).toHaveLength(2);

    const rejected = await askAgent1('c');
    expect(rejected).toMatchObject({
      ok: false,
      errorDetail: { type: 'busy' },
    });

    resolvers[0]('released-1');
    const firstSettled = await Promise.race([pending1, pending2]);
    expect(firstSettled).toMatchObject({ ok: true, result: { text: 'released-1' } });

    // A freed slot admits a new request immediately.
    mocks.askAgentRuntime.mockResolvedValueOnce('admitted-after-release');
    const admittedAfterRelease = await askAgent1('d');
    expect(admittedAfterRelease).toMatchObject({
      ok: true,
      result: { text: 'admitted-after-release' },
    });

    resolvers[1]('released-2');
    await Promise.all([pending1, pending2]);
  }, 90000);

  it('decodes ask requests with and without the optional model_tier field (SO-05)', async () => {
    // SO-05: model_tier is an optional, tolerant field on the ask payload —
    // an old client that omits it must still be served, and a client that
    // sets it must have the daemon forward it as `modelTier` to
    // askAgentRuntime. No protocol version bump required.
    instance = await startAgentRuntimeSupervisorDaemon({
      transport: 'unix',
      socketPath,
      lockPath,
      exitOnFatalError: false,
      exitOnExistingHealthyDaemon: false,
    });

    await expect(
      sendRequest(socketPath, {
        id: 'with-tier',
        method: 'ask',
        payload: {
          agentId: 'agent-1',
          prompt: 'hello',
          requestedBy: 'test',
          model_tier: 'standard',
        },
      })
    ).resolves.toMatchObject({ ok: true, result: { text: 'daemon-ask' } });
    expect(mocks.askAgentRuntime).toHaveBeenCalledWith(
      'agent-1',
      'hello',
      'test',
      expect.objectContaining({ modelTier: 'standard' })
    );

    mocks.askAgentRuntime.mockClear();

    await expect(
      sendRequest(socketPath, {
        id: 'without-tier',
        method: 'ask',
        payload: {
          agentId: 'agent-1',
          prompt: 'hello',
          requestedBy: 'test',
        },
      })
    ).resolves.toMatchObject({ ok: true, result: { text: 'daemon-ask' } });
    expect(mocks.askAgentRuntime).toHaveBeenCalledWith(
      'agent-1',
      'hello',
      'test',
      expect.objectContaining({ modelTier: undefined })
    );
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
