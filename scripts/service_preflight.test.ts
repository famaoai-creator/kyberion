import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inspectServiceAuth: vi.fn(),
  loadServiceEndpointsCatalog: vi.fn(),
  probeServiceRuntime: vi.fn(),
  safeExecResult: vi.fn(),
  getServiceRuntimeRecord: vi.fn(),
  createStandardYargs: vi.fn(),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    inspectServiceAuth: mocks.inspectServiceAuth,
    loadServiceEndpointsCatalog: mocks.loadServiceEndpointsCatalog,
    probeServiceRuntime: mocks.probeServiceRuntime,
    safeExecResult: mocks.safeExecResult,
    getServiceRuntimeRecord: mocks.getServiceRuntimeRecord,
  };
});

vi.mock('@agent/core/cli-utils', () => ({
  createStandardYargs: mocks.createStandardYargs,
}));

describe('service_preflight', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined as never) as any);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy.mockImplementation(((code?: number) => undefined as never) as any);
    const yargsStub = {
      option: vi.fn(() => yargsStub),
      parseSync: vi.fn(() => ({ service: 'voice', all: false, json: false })),
    };
    mocks.createStandardYargs.mockReturnValue(yargsStub);
    mocks.loadServiceEndpointsCatalog.mockReturnValue({
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        voice: { preset_path: 'knowledge/product/orchestration/service-presets/voice.json' },
        meeting: { preset_path: 'knowledge/product/orchestration/service-presets/meeting.json' },
        'media-generation': { preset_path: 'knowledge/product/orchestration/service-presets/media-generation.json' },
        'google-workspace': { preset_path: 'knowledge/product/orchestration/service-presets/google-workspace.json' },
      },
    });
    mocks.inspectServiceAuth.mockImplementation((serviceId: string) => {
      if (serviceId === 'google-workspace') {
        return {
          serviceId,
          authStrategy: 'session',
          valid: true,
          requiredSecrets: [],
          foundSecrets: [],
          missingSecrets: [],
          cliFallbacks: ['gws'],
          setupHint: 'Ready.',
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
        setupHint: 'Ready.',
      };
    });
    mocks.safeExecResult.mockReturnValue({
      stdout: JSON.stringify({ status: 'ok', engines: { macos_say: true } }),
      stderr: '',
      status: 0,
    });
    mocks.getServiceRuntimeRecord.mockReturnValue(null);
    mocks.probeServiceRuntime.mockResolvedValue({
      service: { service_id: 'comfyui' },
      available: true,
      reason: 'probe_succeeded',
      probe_url: 'http://127.0.0.1:8188/system_stats',
      base_url: 'http://127.0.0.1:8188',
      managed_service_path: '/tmp/service-runtimes/comfyui',
    });
  });

  afterEach(() => {
    exitSpy.mockReset();
    logSpy.mockReset();
    errorSpy.mockReset();
  });

  it('reports voice as ready when its bridge health probe passes', async () => {
    const { runServicePreflight } = await import('./service_preflight.js');

    const report = await runServicePreflight({ serviceId: 'voice' });

    expect(report.ready).toBe(true);
    expect(report.reports[0].status).toBe('ready');
    expect(mocks.safeExecResult).toHaveBeenCalled();
  });

  it('reports meeting as ready when its bridge status probe passes', async () => {
    mocks.safeExecResult.mockReturnValueOnce({
      stdout: JSON.stringify({ status: 'success', action: 'status' }),
      stderr: '',
      status: 0,
    });
    const { runServicePreflight } = await import('./service_preflight.js');

    const report = await runServicePreflight({ serviceId: 'meeting' });

    expect(report.ready).toBe(true);
    expect(report.reports[0].status).toBe('ready');
  });

  it('reports media-generation as ready when the local runtime probe passes', async () => {
    const { runServicePreflight } = await import('./service_preflight.js');

    const report = await runServicePreflight({ serviceId: 'media-generation' });

    expect(report.ready).toBe(true);
    expect(mocks.probeServiceRuntime).toHaveBeenCalledWith('comfyui', 'trial');
  });

  it('reports auth-only services as ready when no direct probe is needed', async () => {
    const { runServicePreflight } = await import('./service_preflight.js');

    const report = await runServicePreflight({ serviceId: 'google-workspace' });

    expect(report.ready).toBe(true);
    expect(report.reports[0].directProbeReady).toBeNull();
    expect(report.reports[0].status).toBe('ready');
  });
});
