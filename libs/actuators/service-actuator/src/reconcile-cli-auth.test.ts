import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveServiceBinding: vi.fn(),
  loadServiceEndpointsCatalog: vi.fn(() => ({ services: {} })),
  safeReadFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeExec: vi.fn(),
}));

vi.mock('../../../core/service-binding.js', () => ({
  resolveServiceBinding: mocks.resolveServiceBinding,
  loadServiceEndpointsCatalog: mocks.loadServiceEndpointsCatalog,
}));

// `inspectServiceAuth` validates the preset path with `assertSafeRepositoryPath`
// before ever reading it, so this seam must keep the real (pure, fs-boundary)
// implementation instead of dropping it — only the actual read/exec calls are
// faked. See libs/core/src/pfc/ServiceValidator.ts:123.
vi.mock('../../../core/secure-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/secure-io.js')>()),
  safeReadFile: mocks.safeReadFile,
  safeExistsSync: mocks.safeExistsSync,
  safeExec: mocks.safeExec,
}));

// `inspectServiceAuth` now loads presets through the governed
// service-preset-registry catalog (schema + FoundationIo backed) instead of a
// raw JSON read. These are unit tests for validateServiceAuth's CLI-fallback
// branching, not for catalog/schema plumbing, so mock the registry seam
// directly and keep parsing the same `mocks.safeReadFile` fixture the tests
// already configure.
vi.mock('../../../core/service-preset-registry.js', () => ({
  loadServicePresetAtPath: (presetPath: string, expectedServiceId?: string) => {
    const raw = JSON.parse(String(mocks.safeReadFile(presetPath)));
    return { service_id: raw.service_id || expectedServiceId, ...raw };
  },
}));

import { validateServiceAuth } from '../../../core/src/pfc/ServiceValidator.js';

describe('service-actuator: validateServiceAuth with CLI fallback', () => {
  const MOCK_PRESET_PATH = 'mock-preset.json';
  const SERVICE_ID = 'test-service';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return valid if API token is missing but CLI is authenticated', async () => {
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
        auth_strategy: 'bearer',
        operations: {},
        alternatives: [{ type: 'cli', command: 'gh', health_check: 'gh auth status' }],
      })
    );

    // API token is missing in Vault
    mocks.resolveServiceBinding.mockReturnValue({ serviceId: SERVICE_ID, accessToken: undefined });

    // Mock CLI health check success
    mocks.safeExec.mockReturnValue('Logged in as...');

    const result = await validateServiceAuth(SERVICE_ID, MOCK_PRESET_PATH);
    expect(result.valid).toBe(true);
    expect(mocks.safeExec).toHaveBeenCalledWith('gh', ['auth', 'status']);
  });

  it('should return invalid if both API token and CLI auth are missing', async () => {
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeReadFile.mockReturnValue(
      JSON.stringify({
        auth_strategy: 'bearer',
        operations: {},
        alternatives: [{ type: 'cli', command: 'gh', health_check: 'gh auth status' }],
      })
    );

    // API token is missing
    mocks.resolveServiceBinding.mockReturnValue({ serviceId: SERVICE_ID, accessToken: undefined });

    // Mock CLI health check failure
    mocks.safeExec.mockImplementation(() => {
      throw new Error('Not logged in');
    });

    const result = await validateServiceAuth(SERVICE_ID, MOCK_PRESET_PATH);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no valid CLI fallback found');
  });
});
