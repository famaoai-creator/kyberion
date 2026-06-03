import { describe, expect, it, vi } from 'vitest';
import { StubVideoFrameBus } from './video-frame-bus.js';
import { createVirtualCameraInjectionBridge, VIRTUAL_CAMERA_INJECTION_BRIDGE_ID } from './virtual-camera-injection-bridge.js';

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

function makeInventoryBridge() {
  return {
    bridge_id: 'virtual-device-inventory-bridge',
    probe: vi.fn(async () => ({
      bridge_id: 'virtual-device-inventory-bridge',
      platform: 'darwin',
      available: true,
      inventory: {
        audio_inputs: [],
        audio_outputs: [],
        cameras: [
          { kind: 'camera', name: 'FaceTime HD Camera', platform: 'darwin', source: 'system_profiler', available: true },
        ],
        virtual_audio_devices: [],
        virtual_cameras: [],
        notes: [],
      },
    })),
  };
}

describe('createVirtualCameraInjectionBridge', () => {
  it('probes a replay-capable injection bridge', async () => {
    const bridge = createVirtualCameraInjectionBridge({
      preferred_backend: 'stub',
      inventory_bridge: makeInventoryBridge() as any,
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
      inventory_bridge: makeInventoryBridge() as any,
    });

    const result = await bridge.injectFromMp4('/tmp/in.mp4', {
      device_preference: 'FaceTime HD Camera',
      subject_hint: 'unit-test',
    });

    expect(result.bridge_id).toBe(VIRTUAL_CAMERA_INJECTION_BRIDGE_ID);
    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('replay');
    expect(result.injected_frame_count).toBe(2);
    expect(result.source_path).toContain('/tmp/in.mp4');
  });

  it('injects frames from a bus via the archive boundary', async () => {
    const bridge = createVirtualCameraInjectionBridge({
      preferred_backend: 'stub',
      inventory_bridge: makeInventoryBridge() as any,
    });
    const bus = new StubVideoFrameBus();
    await bus.writeFrames((async function* () {
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
    })());
    await bus.close();

    const result = await bridge.injectBus(bus, {
      subject_hint: 'bus-test',
    });

    expect(result.status).toBe('succeeded');
    expect(result.mode).toBe('replay');
    expect(result.injected_frame_count).toBe(2);
  });
});
