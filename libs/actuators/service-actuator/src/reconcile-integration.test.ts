import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAction } from './index.js';
import actuatorManifestSchema from '../../../../knowledge/product/schemas/actuator-manifest.schema.json';
import serviceManifestSchema from '../../../../knowledge/product/schemas/service-manifest.schema.json';
import serviceActuatorManifest from '../manifest.json';

const mocks = vi.hoisted(() => ({
  resolveServiceBinding: vi.fn(),
  assertSafeRepositoryPath: vi.fn((candidate: string) => {
    if (String(candidate).includes('..')) {
      throw new Error(
        `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${candidate}`
      );
    }
    return candidate;
  }),
  safeReadFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeLstat: vi.fn(() => ({ isFile: () => true })),
  safeWriteFile: vi.fn(),
  derivePipelineStatus: vi.fn((results: Array<{ status: string }>) =>
    results.every((entry) => entry.status === 'success') ? 'succeeded' : 'failed'
  ),
  retry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  executeServicePreset: vi.fn(),
  spawnManagedProcess: vi.fn(),
  validateServiceAuth: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
  runtimeSupervisor: { update: vi.fn(), register: vi.fn(), unregister: vi.fn() },
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/kyberion'),
    rootResolve: vi.fn((p: string) => p),
    shared: vi.fn((p = '') => `active/shared/${p}`),
    sharedTmp: vi.fn((p = '') => `active/shared/tmp/${p}`),
    resolve: vi.fn((p = '') => p),
    knowledge: vi.fn((p = '') => `knowledge/${p}`),
  },
}));

vi.mock('@agent/core/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/foundation')>();
  return {
    ...actual,
    loadJson: <T>(filePath: string) => JSON.parse(String(mocks.safeReadFile(filePath))) as T,
    appendJsonLine: vi.fn(),
    getRegisteredEnv: vi.fn(),
  };
});

// The helper imports canonical subpaths; mirror those seams in the test so
// reconcile exercises its auth/process decisions without reading real state.
vi.mock('@agent/core/core', () => ({ logger: mocks.logger }));
vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  safeReadFile: mocks.safeReadFile,
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
  safeWriteFile: mocks.safeWriteFile,
  safeMkdir: vi.fn(),
  safeExec: vi.fn(),
  safeOpenAppendFile: vi.fn(),
}));
vi.mock('@agent/core/async-utils', () => ({ retry: mocks.retry }));
vi.mock('@agent/core/runtime-supervisor', () => ({ runtimeSupervisor: mocks.runtimeSupervisor }));
vi.mock('@agent/core/managed-process', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
  stopManagedProcess: vi.fn(),
}));
vi.mock('@agent/core/pipeline-contract', () => ({
  derivePipelineStatus: mocks.derivePipelineStatus,
}));
vi.mock('@agent/core/service-binding', () => ({
  resolveServiceBinding: mocks.resolveServiceBinding,
}));
vi.mock('@agent/core/path-resolver', () => ({
  ...mocks.pathResolver,
  pathResolver: mocks.pathResolver,
  capabilityEntry: (id: string) => `dist/${id}.js`,
}));
vi.mock('@agent/core/service-engine', () => ({
  executeServicePreset: mocks.executeServicePreset,
  executeMcp: vi.fn(),
}));
vi.mock('@agent/core/service-validator', () => ({
  validateServiceAuth: mocks.validateServiceAuth,
}));
vi.mock('@agent/core/cloudflare-os-control-plane', () => ({
  CloudflareOsControlPlane: class {
    enforceIntroduction() {}
    recordObservation() {}
  },
}));

describe('service-actuator: RECONCILE with auth check', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.safeReadFile.mockReset();
    mocks.safeReadFile.mockReturnValue('');
    mocks.safeExistsSync.mockReset();
    mocks.safeExistsSync.mockReturnValue(false);
    mocks.safeLstat.mockReset();
    mocks.safeLstat.mockReturnValue({ isFile: () => true });
    mocks.retry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    mocks.derivePipelineStatus.mockImplementation((results: Array<{ status: string }>) =>
      results.every((entry) => entry.status === 'success') ? 'succeeded' : 'failed'
    );
    const foundation = await import('@agent/core/foundation');
    foundation.registerFoundationIo({
      loadJson: <T>(filePath: string): T =>
        String(filePath).endsWith('/service-manifest.schema.json')
          ? (serviceManifestSchema as T)
          : String(filePath).endsWith('/actuator-manifest.schema.json')
            ? (actuatorManifestSchema as T)
            : String(filePath).includes('libs/actuators/service-actuator/manifest.json')
              ? (serviceActuatorManifest as T)
              : (JSON.parse(String(mocks.safeReadFile(filePath))) as T),
      loadJsonIfPresent: <T>(filePath: string): T | null => {
        try {
          return JSON.parse(String(mocks.safeReadFile(filePath))) as T;
        } catch {
          return null;
        }
      },
      appendFile: vi.fn(),
      exists: (filePath: string) =>
        String(filePath).includes('libs/actuators/service-actuator/manifest.json') ||
        mocks.safeExistsSync(filePath),
      readFile: (filePath: string) => String(mocks.safeReadFile(filePath)),
      stat: () => ({ mtimeMs: 0, size: 0 }),
      writeFile: (filePath: string, content: string) => mocks.safeWriteFile(filePath, content),
    });
  });

  it('rejects an external manifest path before reading it', async () => {
    await expect(
      handleAction({
        service_id: 'manager',
        mode: 'RECONCILE',
        action: 'reconcile',
        params: { manifest_path: '../../external-services.json' },
      })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
    expect(mocks.safeReadFile).not.toHaveBeenCalled();
  });

  it('should skip starting a service if validation fails', async () => {
    // 1. Mock manifest
    const manifest = {
      'auth-service': { path: 'src/auth-service.ts', preset_path: 'auth-preset.json' },
    };
    mocks.safeExistsSync.mockImplementation((p: string) => true);
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.includes('auth-preset.json')) {
        return JSON.stringify({ auth_strategy: 'bearer', operations: {} });
      }
      return JSON.stringify(manifest);
    });

    // 2. Mock auth validation failure
    mocks.validateServiceAuth.mockResolvedValue({
      valid: false,
      reason: 'Missing access token',
    });

    // 3. Trigger RECONCILE
    const input = {
      service_id: 'manager',
      mode: 'RECONCILE' as const,
      action: 'reconcile',
      params: { manifest_path: 'services.json' },
    };

    const result = await handleAction(input);

    expect(result.status).toBe('reconciled');
    expect(mocks.pathResolver.rootResolve).toHaveBeenCalledWith('services.json');
    // Service should NOT be started due to missing auth
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Auth validation failed for auth-service')
    );
  });

  it('rejects a malformed manifest before reconcile or cleanup can mutate services', async () => {
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
        'bad-service': { path: 'bridge.js', env: { PORT: 3317 } },
      })
    );

    await expect(
      handleAction({
        service_id: 'manager',
        mode: 'RECONCILE',
        action: 'reconcile',
        params: { manifest_path: 'services.json', cleanup: true },
      })
    ).rejects.toThrow('Service manifest has an invalid shape');

    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
    expect(mocks.safeWriteFile).not.toHaveBeenCalled();
  });

  it('should start a service if validation passes', async () => {
    // 1. Mock manifest
    const manifest = {
      'good-service': { path: 'src/good-service.ts', preset_path: 'good-preset.json' },
    };
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.includes('good-preset.json')) {
        return JSON.stringify({ auth_strategy: 'none', operations: {} });
      }
      return JSON.stringify(manifest);
    });

    // 2. Mock auth validation success and spawn return
    mocks.validateServiceAuth.mockResolvedValue({ valid: true });
    mocks.spawnManagedProcess.mockReturnValue({ child: { pid: 1234, unref: vi.fn() } });

    // 3. Trigger RECONCILE
    const input = {
      service_id: 'manager',
      mode: 'RECONCILE' as const,
      action: 'reconcile',
      params: { manifest_path: 'services.json' },
    };

    const result = await handleAction(input);

    expect(result.status).toBe('reconciled');
    // Service SHOULD be started
    expect(mocks.spawnManagedProcess).toHaveBeenCalled();
    expect(mocks.logger.success).toHaveBeenCalledWith(
      expect.stringContaining('good-service started')
    );
  });

  it('writes pipeline context to root-resolved context_path', async () => {
    mocks.executeServicePreset.mockResolvedValue({ ok: true, id: 'preset-result' });

    const result = await handleAction({
      action: 'pipeline',
      context: {
        context_path: 'active/shared/tmp/service-context.json',
      },
      steps: [
        {
          op: 'preset',
          params: {
            service_id: 'slack',
            action: 'post_message',
            params: { text: 'hello' },
            export_as: 'message_result',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(mocks.pathResolver.rootResolve).toHaveBeenCalledWith(
      'active/shared/tmp/service-context.json'
    );
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      'active/shared/tmp/service-context.json',
      expect.stringContaining('"message_result"')
    );
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'slack',
      'post_message',
      { text: 'hello' },
      'none'
    );
  });
});
