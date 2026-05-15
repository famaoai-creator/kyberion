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

vi.mock('../../../core/secure-io.js', () => ({
  safeReadFile: mocks.safeReadFile,
  safeExistsSync: mocks.safeExistsSync,
  safeExec: mocks.safeExec,
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
    mocks.safeReadFile.mockReturnValue(JSON.stringify({
      auth_strategy: 'bearer',
      operations: {},
      alternatives: [
        { type: 'cli', command: 'gh', health_check: 'gh auth status' }
      ]
    }));
    
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
    mocks.safeReadFile.mockReturnValue(JSON.stringify({
      auth_strategy: 'bearer',
      operations: {},
      alternatives: [
        { type: 'cli', command: 'gh', health_check: 'gh auth status' }
      ]
    }));
    
    // API token is missing
    mocks.resolveServiceBinding.mockReturnValue({ serviceId: SERVICE_ID, accessToken: undefined });
    
    // Mock CLI health check failure
    mocks.safeExec.mockImplementation(() => { throw new Error('Not logged in'); });

    const result = await validateServiceAuth(SERVICE_ID, MOCK_PRESET_PATH);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no valid CLI fallback found');
  });
});
