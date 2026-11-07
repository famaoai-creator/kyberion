import { afterEach, describe, expect, it } from 'vitest';
import {
  listCameraOutputBridges,
  registerCameraOutputBridge,
  resetCameraOutputBridges,
  resolveCameraOutputBridge,
  type CameraOutputBridge,
} from './camera-output-bridge.js';

function fakeBridge(
  id: string,
  available: boolean,
  reason = 'missing dependency'
): CameraOutputBridge {
  return {
    bridge_id: id,
    capabilities: { virtual_camera: true, looping_source: true, scene_switching: true },
    probe: async () => (available ? { available: true } : { available: false, reason }),
    startAvatarOutput: async () => ({ scene: 's', source: 'v', virtualCamStarted: true }),
    stopAvatarOutput: async () => undefined,
  };
}

describe('camera-output-bridge seam', () => {
  afterEach(() => {
    resetCameraOutputBridges();
  });

  it('resolves an explicit backend only when probed available', async () => {
    registerCameraOutputBridge(fakeBridge('obs-virtual-cam', true));
    const backend = await resolveCameraOutputBridge('obs-virtual-cam');
    expect(backend.bridge_id).toBe('obs-virtual-cam');

    resetCameraOutputBridges();
    registerCameraOutputBridge(fakeBridge('obs-virtual-cam', false, 'no server'));
    await expect(resolveCameraOutputBridge('obs-virtual-cam')).rejects.toThrow(/no server/);
  });

  it('rejects unknown backend ids with the registered list', async () => {
    registerCameraOutputBridge(fakeBridge('obs-virtual-cam', true));
    await expect(resolveCameraOutputBridge('v4l2')).rejects.toThrow(/obs-virtual-cam/);
  });

  it('auto-selects the first probed-available backend and never a stub', async () => {
    registerCameraOutputBridge(fakeBridge('stub', true));
    registerCameraOutputBridge(fakeBridge('obs-virtual-cam', true));
    expect(listCameraOutputBridges().map((entry) => entry.bridge_id)).toEqual(
      expect.arrayContaining(['stub', 'obs-virtual-cam'])
    );
    const backend = await resolveCameraOutputBridge('auto');
    expect(backend.bridge_id).toBe('obs-virtual-cam');

    resetCameraOutputBridges();
    registerCameraOutputBridge(fakeBridge('stub', true));
    await expect(resolveCameraOutputBridge('auto')).rejects.toThrow(/no usable camera backend/);
  });
});
