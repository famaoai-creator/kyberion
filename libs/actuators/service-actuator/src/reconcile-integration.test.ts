import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAction } from './index.js';

const mocks = vi.hoisted(() => ({
  resolveServiceBinding: vi.fn(),
  safeReadFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeWriteFile: vi.fn(),
  spawnManagedProcess: vi.fn(),
  validateServiceAuth: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
  runtimeSupervisor: { update: vi.fn(), register: vi.fn(), unregister: vi.fn() }
}));

vi.mock('@agent/core', () => ({
  resolveServiceBinding: mocks.resolveServiceBinding,
  safeReadFile: mocks.safeReadFile,
  safeExistsSync: mocks.safeExistsSync,
  safeWriteFile: mocks.safeWriteFile,
  safeAppendFile: vi.fn(), // Added
  safeOpenAppendFile: vi.fn(),
  safeMkdir: vi.fn(),
  spawnManagedProcess: mocks.spawnManagedProcess,
  validateServiceAuth: mocks.validateServiceAuth,
  logger: mocks.logger,
  runtimeSupervisor: mocks.runtimeSupervisor,
  pathResolver: {
    rootDir: () => '/tmp/kyberion',
    rootResolve: (p: string) => p,
    shared: (p = '') => `active/shared/${p}`,
    resolve: (p = '') => p,
    knowledge: (p = '') => `knowledge/${p}`,
  },
  capabilityEntry: (id: string) => `dist/${id}.js`
}));

describe('service-actuator: RECONCILE with auth check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip starting a service if validation fails', async () => {
    // 1. Mock manifest
    const manifest = {
      'auth-service': { path: 'src/auth-service.ts', preset_path: 'auth-preset.json' }
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
      params: { manifest_path: 'services.json' }
    };

    const result = await handleAction(input);

    expect(result.status).toBe('reconciled');
    // Service should NOT be started due to missing auth
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Auth validation failed for auth-service'));
  });

  it('should start a service if validation passes', async () => {
    // 1. Mock manifest
    const manifest = {
      'good-service': { path: 'src/good-service.ts', preset_path: 'good-preset.json' }
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
      params: { manifest_path: 'services.json' }
    };

    const result = await handleAction(input);

    expect(result.status).toBe('reconciled');
    // Service SHOULD be started
    expect(mocks.spawnManagedProcess).toHaveBeenCalled();
    expect(mocks.logger.success).toHaveBeenCalledWith(expect.stringContaining('good-service started'));
  });
});
