import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import {
  getServiceRuntimeRecord,
  getServiceRuntimeRegistry,
  listServiceRuntimeInventory,
  probeServiceRuntime,
  _resetServiceRuntimeRegistryCacheForTests,
} from './service-runtime-registry.js';

const mocks = vi.hoisted(() => {
  const secureFetch = vi.fn();
  return { secureFetch };
});

vi.mock('./network.js', () => ({
  secureFetch: mocks.secureFetch,
}));

describe('service-runtime-registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetServiceRuntimeRegistryCacheForTests();
    mocks.secureFetch.mockResolvedValue({ ok: true });
  });

  it('loads the canonical comfyui registry entry', () => {
    const registry = getServiceRuntimeRegistry();
    expect(registry.default_service_id).toBe('comfyui');
    expect(getServiceRuntimeRecord('comfyui')).toMatchObject({
      service_id: 'comfyui',
      display_name: 'ComfyUI Local Service Runtime',
      kind: 'local_service',
      service_preset_path: 'knowledge/product/orchestration/service-presets/comfyui.json',
    });
  });

  it('probes comfyui through the service runtime layer', async () => {
    const resolution = await probeServiceRuntime('comfyui', 'trial', 'darwin');
    expect(resolution.available).toBe(true);
    expect(resolution.probe_url).toBe('http://127.0.0.1:8188/system_stats');
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://127.0.0.1:8188/system_stats',
        kyberion_allow_local_network: true,
      })
    );
  });

  it('lists service runtime inventory with lifecycle metadata', async () => {
    const inventory = await listServiceRuntimeInventory('trial', 'darwin');
    expect(inventory.default_service_id).toBe('comfyui');
    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({
      service: expect.objectContaining({ service_id: 'comfyui' }),
      lifecycle_stage: 'trial',
      available: true,
      selected_action: 'probe',
    });
  });

  it('rejects a managed service subpath that escapes the governed runtime root', async () => {
    const registryPath = pathResolver.sharedTmp(
      `service-runtime-registry-escape-${process.pid}.json`
    );
    process.env.KYBERION_SERVICE_RUNTIME_REGISTRY_PATH = registryPath;
    safeWriteFile(
      registryPath,
      JSON.stringify({
        version: 'test',
        default_service_id: 'escape-test',
        services: [
          {
            service_id: 'escape-test',
            display_name: 'Escape test',
            kind: 'local_service',
            status: 'active',
            platforms: ['any'],
            supported_modes: ['trial'],
            trial_probe: { kind: 'http', method: 'GET', path: 'health' },
            managed_service_subpath: '../outside',
          },
        ],
      })
    );
    _resetServiceRuntimeRegistryCacheForTests();
    await expect(probeServiceRuntime('escape-test', 'trial', 'darwin')).rejects.toThrow(
      /escapes its root/
    );
    safeRmSync(registryPath, { force: true });
    delete process.env.KYBERION_SERVICE_RUNTIME_REGISTRY_PATH;
    _resetServiceRuntimeRegistryCacheForTests();
  });
});
