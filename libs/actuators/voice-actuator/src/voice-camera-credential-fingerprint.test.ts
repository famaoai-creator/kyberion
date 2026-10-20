import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  key: 'protected-installation-key-fixture' as string | null,
  bridges: new Map<string, object>(),
  run: vi.fn(async (_operation: unknown, execute: () => Promise<unknown>) => execute()),
  stop: vi.fn(async () => undefined),
  install: vi.fn(),
}));
vi.mock('@agent/core/chain-integrity', async (original) => ({
  ...(await original<typeof import('@agent/core/chain-integrity')>()),
  resolveAuditChainKey: () => fixture.key,
}));
// This suite isolates credential identity, not the approval gate. Real camera
// admission/transport behavior is covered by voice-external-governance.test.ts.
vi.mock('@agent/core/governance/external-operation', () => ({ runExternalOperation: fixture.run }));
vi.mock('@agent/core/obs-virtual-camera-output', () => ({
  installObsVirtualCameraOutputBridge: () => {
    fixture.install();
    fixture.bridges.set('obs-virtual-cam', {
      bridge_id: 'obs-virtual-cam',
      stopAvatarOutput: fixture.stop,
    });
  },
}));
vi.mock('@agent/core/camera-output-bridge', () => ({
  listCameraOutputBridges: () => [...fixture.bridges.values()],
  resolveCameraOutputBridge: async (id: string) => fixture.bridges.get(id),
}));

describe('camera credential fingerprint', () => {
  const input = {
    action: 'output_to_virtual_camera' as const,
    backend: 'obs-virtual-cam',
    stop: true,
    obs_host: 'camera.example.invalid',
    obs_port: 4455,
    obs_password: 'low-entropy-camera-password',
  };
  const invoke = async (override: Partial<typeof input> = {}) => {
    const { outputToVirtualCamera } = await import('./voice-media-output-helpers.js');
    await outputToVirtualCamera({ ...input, ...override });
    const operation = fixture.run.mock.calls.at(-1)![0] as {
      effect: { target: { credential_hash: string } };
    };
    return operation.effect.target.credential_hash;
  };
  const restart = () => {
    vi.resetModules();
    fixture.bridges.clear();
  };
  beforeEach(() => {
    vi.clearAllMocks();
    restart();
    fixture.key = 'protected-installation-key-fixture';
  });
  it('keeps approval credential identity stable after a simulated process restart', async () => {
    const first = await invoke();
    expect(await invoke()).toBe(first);
    restart();
    expect(await invoke()).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(fixture.run.mock.calls)).not.toContain(input.obs_password);
    expect(JSON.stringify(fixture.run.mock.calls)).not.toContain(fixture.key);
  });
  it('rejects password and URL drift on an installed bridge', async () => {
    await invoke();
    await expect(invoke({ obs_password: 'changed-password' })).rejects.toThrow(
      'VOICE_CAMERA_CONFIG_DRIFT'
    );
    await expect(invoke({ obs_host: 'other.example.invalid' })).rejects.toThrow(
      'VOICE_CAMERA_CONFIG_DRIFT'
    );
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  });
  it('changes approval identity for password, host, port and installation-key changes', async () => {
    const original = await invoke();
    for (const changed of [
      { obs_password: 'changed-password' },
      { obs_host: 'other.example.invalid' },
      { obs_port: 4456 },
    ]) {
      restart();
      expect(await invoke(changed)).not.toBe(original);
    }
    restart();
    fixture.key = 'rotated-protected-installation-key';
    expect(await invoke()).not.toBe(original);
  });
  it('fails closed without an installation key before registering or changing a camera', async () => {
    fixture.key = null;
    await expect(invoke()).rejects.toThrow('VOICE_CAMERA_KEY_UNAVAILABLE');
    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });
});
