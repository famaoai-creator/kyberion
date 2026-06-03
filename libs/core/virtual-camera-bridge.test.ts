import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { createVirtualCameraBridge, VIRTUAL_CAMERA_BRIDGE_ID } from './virtual-camera-bridge.js';
import { StubVideoFrameBus } from './video-frame-bus.js';
import { safeReadFile } from './secure-io.js';

describe('createVirtualCameraBridge', () => {
  it('exposes a stable bridge identity', async () => {
    const bridge = createVirtualCameraBridge({ preferred_backend: 'stub' });
    const probe = await bridge.probe();
    expect(probe.bridge_id).toBe(VIRTUAL_CAMERA_BRIDGE_ID);
    expect(probe.backend).toBe('stub');
    expect(probe.available).toBe(true);
  });

  it('captures a placeholder image in stub mode', async () => {
    const bridge = createVirtualCameraBridge({ preferred_backend: 'stub' });
    const outPath = path.join('active', 'shared', 'tmp', `camera-bridge-${Date.now()}.png`);
    const result = await bridge.capturePhoto({
      save_path: outPath,
      camera_intent: 'record',
      subject_hint: 'unit-test',
    });

    expect(result.bridge_id).toBe(VIRTUAL_CAMERA_BRIDGE_ID);
    expect(result.backend).toBe('stub');
    expect(result.save_path).toContain('camera-bridge-');

    const buf = safeReadFile(outPath, { encoding: null }) as Buffer;
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(1, 4).toString('utf8')).toBe('PNG');
  });

  it('streams repeated frames in stub mode', async () => {
    const bridge = createVirtualCameraBridge({ preferred_backend: 'stub' });
    const frames = [];
    for await (const frame of bridge.captureStream({ max_frames: 2, frame_interval_ms: 0 })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(expect.objectContaining({
      format: expect.objectContaining({
        mime_type: 'image/jpeg',
      }),
    }));
    expect(frames[0].payload.byteLength).toBeGreaterThan(0);
  });

  it('pipes camera frames into a video frame bus', async () => {
    const bridge = createVirtualCameraBridge({ preferred_backend: 'stub' });
    const bus = new StubVideoFrameBus();
    const frames: Array<{ ts_ms: number; bytes: number }> = [];
    const reader = (async () => {
      for await (const frame of bus.frameStream()) {
        frames.push({ ts_ms: frame.ts_ms, bytes: frame.payload.byteLength });
      }
    })();

    await bridge.pipeTo(bus, { max_frames: 2, frame_interval_ms: 0 });
    await bus.close();
    await reader;

    expect(frames).toHaveLength(2);
    expect(frames[0].bytes).toBeGreaterThan(0);
  });
});
