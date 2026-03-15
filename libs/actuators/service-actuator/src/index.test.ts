import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const spawnManagedProcess = vi.fn();
  const stopManagedProcess = vi.fn();
  const secureFetch = vi.fn();
  const safeExec = vi.fn();
  const safeReadFile = vi.fn();
  const safeWriteFile = vi.fn();
  const safeAppendFile = vi.fn();
  const safeExistsSync = vi.fn();
  const safeMkdir = vi.fn();
  const safeOpenAppendFile = vi.fn(() => 1);
  const withRetry = vi.fn(async (fn: () => Promise<unknown>) => await fn());
  const derivePipelineStatus = vi.fn(() => 'succeeded');
  const resolveServiceBinding = vi.fn();
  const capabilityEntry = vi.fn((id: string) => `/dist/${id}.js`);
  const register = vi.fn();
  const update = vi.fn(() => false);
  const unregister = vi.fn();
  const touch = vi.fn();

  return {
    spawnManagedProcess,
    stopManagedProcess,
    secureFetch,
    safeExec,
    safeReadFile,
    safeWriteFile,
    safeAppendFile,
    safeExistsSync,
    safeMkdir,
    safeOpenAppendFile,
    withRetry,
    derivePipelineStatus,
    resolveServiceBinding,
    capabilityEntry,
    register,
    update,
    unregister,
    touch,
  };
});

vi.mock('@agent/core', () => ({
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  safeExec: mocks.safeExec,
  safeReadFile: mocks.safeReadFile,
  safeWriteFile: mocks.safeWriteFile,
  safeAppendFile: mocks.safeAppendFile,
  safeExistsSync: mocks.safeExistsSync,
  safeMkdir: mocks.safeMkdir,
  safeOpenAppendFile: mocks.safeOpenAppendFile,
  withRetry: mocks.withRetry,
  runtimeSupervisor: {
    register: mocks.register,
    update: mocks.update,
    unregister: mocks.unregister,
    touch: mocks.touch,
  },
  spawnManagedProcess: mocks.spawnManagedProcess,
  stopManagedProcess: mocks.stopManagedProcess,
  derivePipelineStatus: mocks.derivePipelineStatus,
  resolveServiceBinding: mocks.resolveServiceBinding,
  capabilityEntry: mocks.capabilityEntry,
  createStandardYargs: () => ({
    option() {
      return this;
    },
    parseSync() {
      return { input: 'input.json' };
    },
  }),
}));

vi.mock('@agent/core/network', () => ({
  secureFetch: mocks.secureFetch,
}));

describe('service-actuator handleAction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveServiceBinding.mockReturnValue({
      serviceId: 'slack',
      authMode: 'secret-guard',
      accessToken: 'xoxb-token',
    });
    mocks.safeExistsSync.mockReturnValue(false);
    mocks.spawnManagedProcess.mockReturnValue({
      child: { pid: 4242, unref: vi.fn() },
    });
    delete process.env.KYBERION_ALLOW_UNSAFE_CLI;
  });

  it('dispatches API mode through secureFetch', async () => {
    const { handleAction } = await import('./index.js');
    mocks.secureFetch.mockResolvedValue({ ok: true });

    const result = await handleAction({
      service_id: 'slack',
      mode: 'API',
      action: 'chat.postMessage',
      method: 'POST',
      params: { channel: 'C1', text: 'hello' },
      auth: 'secret-guard',
    });

    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://slack.com/api/chat.postMessage',
        headers: { Authorization: 'Bearer xoxb-token' },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects slack streaming in service-actuator', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        service_id: 'slack',
        mode: 'STREAM',
        action: 'connect',
        params: {},
        auth: 'secret-guard',
      }),
    ).rejects.toThrow('Slack streaming ingress belongs to the Slack gateway');
  });

  it('blocks unsafe CLI mode unless explicitly enabled', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        service_id: 'slack',
        mode: 'CLI',
        action: 'post-message',
        params: { text: 'hello' },
        auth: 'secret-guard',
      }),
    ).rejects.toThrow('CLI execution disabled');
  });

  it('reconciles missing services by spawning managed processes', async () => {
    const { handleAction } = await import('./index.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith('manifest.json')) {
        return JSON.stringify({
          'slack-bridge': { path: 'satellites/slack-bridge/src/index.ts' },
        });
      }
      if (String(filePath).endsWith('services-pids.json')) {
        return JSON.stringify({});
      }
      return '{}';
    });

    const result = await handleAction({
      service_id: 'system',
      mode: 'RECONCILE',
      action: 'reconcile',
      params: { manifest_path: 'manifest.json', cleanup: false },
      auth: 'none',
    });

    expect(mocks.spawnManagedProcess).toHaveBeenCalled();
    expect(mocks.register).toHaveBeenCalled();
    expect(mocks.safeWriteFile).toHaveBeenCalled();
    expect(result).toEqual({ status: 'reconciled', active_services: ['slack-bridge'] });
  });
});
