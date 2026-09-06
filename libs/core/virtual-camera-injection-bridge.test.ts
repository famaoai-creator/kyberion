import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeWriteFile } from './secure-io.js';
import { StubVideoFrameBus } from './video-frame-bus.js';
import {
  createVirtualCameraInjectionBridge,
  VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
} from './virtual-camera-injection-bridge.js';
import type {
  VirtualDeviceInventory,
  VirtualDeviceInventoryBridge,
} from './virtual-device-inventory-bridge.js';

vi.mock('./video-frame-archive.js', async () => {
  const actual = await vi.importActual<any>('./video-frame-archive.js');
  return {
    ...actual,
    readVideoFramesFromMp4: vi.fn(async function* () {
      yield {
        format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
        payload: new Uint8Array([1, 2, 3]),
        ts_ms: 0,
      };
      yield {
        format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
        payload: new Uint8Array([4, 5, 6]),
        ts_ms: 33,
      };
    }),
    writeVideoFramesToMp4: vi.fn(async (outputPath: string, frames: AsyncIterable<any>) => {
      let count = 0;
      let format: any;
      for await (const frame of frames) {
        count += 1;
        format = format || frame.format;
      }
      return {
        output_path: outputPath,
        frame_count: count,
        fps: 30,
        format: format || { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
      };
    }),
  };
});

function makeInventoryBridge(): VirtualDeviceInventoryBridge {
  const inventory: VirtualDeviceInventory = {
    audio_inputs: [],
    audio_outputs: [],
    cameras: [
      {
        kind: 'camera',
        name: 'FaceTime HD Camera',
        platform: 'darwin',
        source: 'system_profiler',
        available: true,
      },
    ],
    virtual_audio_devices: [],
    virtual_cameras: [],
    notes: [],
  };
  return {
    bridge_id: 'virtual-device-inventory-bridge',
    probe: vi.fn(async () => ({
      bridge_id: 'virtual-device-inventory-bridge',
      platform: 'darwin',
      available: true,
      inventory,
    })),
    scan: vi.fn(async () => inventory),
  };
}

describe('createVirtualCameraInjectionBridge', () => {
  it('probes a replay-capable injection bridge', async () => {
    const bridge = createVirtualCameraInjectionBridge({
      preferred_backend: 'stub',
      inventory_bridge: makeInventoryBridge(),
    });

    const probe = await bridge.probe();
    expect(probe.bridge_id).toBe(VIRTUAL_CAMERA_INJECTION_BRIDGE_ID);
    expect(probe.backend).toBe('stub');
    expect(probe.available).toBe(true);
    expect(probe.selected_camera).toBe('FaceTime HD Camera');
  });

  it('injects an mp4 by replaying frames in stub mode', async () => {
    const bridge = createVirtualCameraInjectionBridge({
      preferred_backend: 'stub',
      inventory_bridge: makeInventoryBridge(),
    });

    const sourcePath = pathResolver.sharedTmp('virtual-camera-injection/in.mp4');
    safeWriteFile(sourcePath, 'fixture');
    const result = await bridge.injectFromMp4(sourcePath, {
      device_preference: 'FaceTime HD Camera',
      subject_hint: 'unit-test',
    });

    expect(result.bridge_id).toBe(VIRTUAL_CAMERA_INJECTION_BRIDGE_ID);
    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('replay');
    expect(result.injected_frame_count).toBe(2);
    expect(result.source_path).toBe(sourcePath);
  });

  it('rejects an mp4 source outside the repository', async () => {
    const bridge = createVirtualCameraInjectionBridge({
      preferred_backend: 'stub',
      inventory_bridge: makeInventoryBridge(),
    });

    await expect(bridge.injectFromMp4('/tmp/in.mp4')).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects a replay output path outside the repository', async () => {
    const bridge = createVirtualCameraInjectionBridge({
      preferred_backend: 'stub',
      inventory_bridge: makeInventoryBridge(),
    });
    const sourcePath = pathResolver.sharedTmp('virtual-camera-injection/output-check.mp4');
    safeWriteFile(sourcePath, 'fixture');

    await expect(
      bridge.injectFromMp4(sourcePath, { output_path: '/tmp/replay-output.mp4' })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('injects frames from a bus via the archive boundary', async () => {
    const bridge = createVirtualCameraInjectionBridge({
      preferred_backend: 'stub',
      inventory_bridge: makeInventoryBridge(),
    });
    const bus = new StubVideoFrameBus();
    await bus.writeFrames(
      (async function* () {
        yield {
          format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
          payload: new Uint8Array([7, 8, 9]),
          ts_ms: 0,
        };
        yield {
          format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
          payload: new Uint8Array([10, 11, 12]),
          ts_ms: 33,
        };
      })()
    );
    await bus.close();

    const result = await bridge.injectBus(bus, {
      subject_hint: 'bus-test',
    });

    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('replay');
    expect(result.injected_frame_count).toBe(2);
  });
});
