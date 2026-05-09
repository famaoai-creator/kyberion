import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  loadSurfaceManifest: vi.fn(),
  loadSurfaceState: vi.fn(),
  validateServiceAuth: vi.fn(),
  inspectServiceAuth: vi.fn(),
  spawnManagedProcess: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
  surfaceManifestDirectoryPath: vi.fn(() => '/tmp/kyberion/knowledge/public/governance/surfaces'),
  surfaceManifestPath: vi.fn(() => '/tmp/kyberion/knowledge/public/governance/active-surfaces.json'),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    loadSurfaceManifest: mocks.loadSurfaceManifest,
    loadSurfaceState: mocks.loadSurfaceState,
    validateServiceAuth: mocks.validateServiceAuth,
    inspectServiceAuth: mocks.inspectServiceAuth,
    spawnManagedProcess: mocks.spawnManagedProcess,
    logger: mocks.logger,
    surfaceManifestDirectoryPath: mocks.surfaceManifestDirectoryPath,
    surfaceManifestPath: mocks.surfaceManifestPath,
  };
});

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
    mocks.inspectServiceAuth.mockReturnValue({
      serviceId: 'test-service',
      presetPath: 'test-preset.json',
      authStrategy: 'bearer',
      valid: false,
      reason: 'No token',
      requiredSecrets: ['TEST-SERVICE_ACCESS_TOKEN'],
      foundSecrets: [],
      missingSecrets: ['TEST-SERVICE_ACCESS_TOKEN'],
      cliFallbacks: ['test-cli'],
      setupHint: 'Set one of: TEST-SERVICE_ACCESS_TOKEN',
    });

    const result = await startSurfaceById('auth-surface', 'manifest.json');

    expect(result.status).toBe('skipped_auth_required');
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Auth validation failed for auth-surface'));
  });

  it('should surface auth readiness details in setup report', async () => {
    const { setupSurfaces } = await import('../scripts/surface_runtime');

    mocks.loadSurfaceManifest.mockReturnValue({
      version: 1,
      surfaces: [
        { id: 'slack-bridge', kind: 'gateway', enabled: true, service_id: 'slack', preset_path: 'slack.json' },
        { id: 'imessage-bridge', kind: 'service', enabled: true },
      ],
    });
    mocks.inspectServiceAuth.mockImplementation((serviceId: string) => {
      if (serviceId === 'slack') {
        return {
          serviceId,
          presetPath: 'slack.json',
          authStrategy: 'bearer',
          valid: false,
          reason: 'Missing credentials',
          requiredSecrets: ['SLACK_ACCESS_TOKEN'],
          foundSecrets: [],
          missingSecrets: ['SLACK_ACCESS_TOKEN'],
          cliFallbacks: ['slack-cli'],
          setupHint: 'Set one of: SLACK_ACCESS_TOKEN',
        };
      }
      return {
        serviceId,
        authStrategy: 'none',
        valid: true,
        requiredSecrets: [],
        foundSecrets: [],
        missingSecrets: [],
        cliFallbacks: [],
        setupHint: 'No preset found; this surface is host-managed or uses a non-service auth path.',
      };
    });

    const result = await setupSurfaces();

    expect(result.status).toBe('ok');
    expect(result.summary).toMatchObject({
      missing: 1,
      ready: 0,
      hostManaged: 1,
      disabled: 0,
      total: 2,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      surface: 'slack-bridge',
      auth: 'missing',
      strategy: 'bearer',
    });
    expect(result.rows[1]).toMatchObject({
      surface: 'imessage-bridge',
      auth: 'n/a',
      strategy: 'host-managed',
    });
  });
});
