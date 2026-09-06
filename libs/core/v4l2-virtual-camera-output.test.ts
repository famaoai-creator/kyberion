import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  V4L2_VIRTUAL_CAMERA_BRIDGE_ID,
  V4l2VirtualCameraOutputBridge,
} from './v4l2-virtual-camera-output.js';
import type { VirtualCameraInjectionBridge } from './virtual-camera-injection-bridge.js';

function fakeInjectionBridge(backend: 'ffmpeg-v4l2' | 'stub'): VirtualCameraInjectionBridge {
  return {
    bridge_id: 'virtual-camera-injection-bridge',
    probe: vi.fn(async () => ({
      bridge_id: 'virtual-camera-injection-bridge',
      platform: 'linux',
      backend,
      available: true,
      selected_device_path: backend === 'ffmpeg-v4l2' ? '/dev/video2' : undefined,
    })),
    injectFromMp4: vi.fn(async () => ({
      bridge_id: 'virtual-camera-injection-bridge',
      platform: 'linux',
      backend: 'ffmpeg-v4l2',
      mode: 'device',
      status: 'succeeded',
      selected_device_path: '/dev/video2',
    })),
    injectFrames: vi.fn(),
    injectBus: vi.fn(),
  } as unknown as VirtualCameraInjectionBridge;
}

describe('v4l2 virtual-camera output seam backend', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('exposes the existing Linux injection path through camera-output-bridge', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const injection = fakeInjectionBridge('ffmpeg-v4l2');
    const bridge = new V4l2VirtualCameraOutputBridge({
      devicePath: '/dev/video2',
      ffmpegBin: 'true',
      injectionBridge: injection,
    });

    await expect(bridge.probe()).resolves.toEqual({ available: true });
    await expect(
      bridge.startAvatarOutput({ videoPath: 'active/shared/tmp/avatar.mp4' })
    ).resolves.toMatchObject({
      scene: 'v4l2',
      source: '/dev/video2',
      virtualCamStarted: true,
    });
    expect(injection.injectFromMp4).toHaveBeenCalledWith(
      'active/shared/tmp/avatar.mp4',
      expect.objectContaining({ device_path: '/dev/video2' })
    );
  });

  it('reports setup guidance when no Linux v4l2 device is selected', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const bridge = new V4l2VirtualCameraOutputBridge({
      devicePath: '/dev/video2',
      ffmpegBin: 'true',
      injectionBridge: fakeInjectionBridge('stub'),
    });

    await expect(bridge.probe()).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/v4l2/iu),
    });
  });
});
