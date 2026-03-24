import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock @agent/core to intercept surface loading and spawning
const mocks = vi.hoisted(() => ({
  loadSurfaceManifest: vi.fn(),
  loadSurfaceState: vi.fn(),
  validateServiceAuth: vi.fn(),
  spawnManagedProcess: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() }
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    loadSurfaceManifest: mocks.loadSurfaceManifest,
    loadSurfaceState: mocks.loadSurfaceState,
    validateServiceAuth: mocks.validateServiceAuth,
    spawnManagedProcess: mocks.spawnManagedProcess,
    logger: mocks.logger,
  };
});

// We need to import the script logic. Since it's a script, we'll mock the main parts
// but for TDD we really want to test startSurfaceById. 
// We might need to export startSurfaceById from surface_runtime.ts first.

describe('surface_runtime: startSurfaceById with auth validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSurfaceState.mockReturnValue({ surfaces: {} });
  });

  it('should skip starting a surface if auth validation fails', async () => {
    const { startSurfaceById } = await import('../scripts/surface_runtime');

    const manifest = {
      version: 1,
      surfaces: [{
        id: 'auth-surface',
        enabled: true,
        service_id: 'test-service',
        preset_path: 'test-preset.json'
      }]
    };
    mocks.loadSurfaceManifest.mockReturnValue(manifest);
    
    // Mock auth failure
    mocks.validateServiceAuth.mockResolvedValue({ valid: false, reason: 'No token' });

    const result = await startSurfaceById('auth-surface', 'manifest.json');

    expect(result.status).toBe('skipped_auth_required');
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Auth validation failed for auth-surface'));
  });
});
