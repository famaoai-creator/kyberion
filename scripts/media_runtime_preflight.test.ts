import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  probeServiceRuntime: vi.fn(),
  createStandardYargs: vi.fn(),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    probeServiceRuntime: mocks.probeServiceRuntime,
  };
});

vi.mock('@agent/core/cli-utils', () => ({
  createStandardYargs: mocks.createStandardYargs,
}));

describe('media_runtime_preflight', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined as never) as any);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy.mockImplementation(((code?: number) => undefined as never) as any);
    const yargsStub = {
      option: vi.fn(() => yargsStub),
      parseSync: vi.fn(() => ({ service: 'comfyui', json: false })),
    };
    mocks.createStandardYargs.mockReturnValue(yargsStub);
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
    errorSpy.mockReset();
  });

  it('reports the media service runtime as available', async () => {
    const { runMediaRuntimePreflight } = await import('./media_runtime_preflight.js');

    const report = await runMediaRuntimePreflight({ serviceId: 'comfyui' });

    expect(report.available).toBe(true);
    expect(report.reason).toBe('probe_succeeded');
    expect(mocks.probeServiceRuntime).toHaveBeenCalledWith('comfyui', 'trial');
  });

  it('exits non-zero when the media service runtime is unavailable', async () => {
    mocks.probeServiceRuntime.mockResolvedValueOnce({
      service: { service_id: 'comfyui' },
      available: false,
      reason: 'probe_failed',
      base_url: 'http://127.0.0.1:8188',
      managed_service_path: '/tmp/service-runtimes/comfyui',
    });

    const { runMediaRuntimePreflight } = await import('./media_runtime_preflight.js');

    const report = await runMediaRuntimePreflight({ serviceId: 'comfyui' });

    expect(report.available).toBe(false);
    expect(report.reason).toBe('probe_failed');
  });
});
