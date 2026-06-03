import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from './secure-io.js';
import { createScreenCaptureBridge, SCREEN_CAPTURE_BRIDGE_ID } from './screen-capture-bridge.js';
import { StubVideoFrameBus } from './video-frame-bus.js';

describe('createScreenCaptureBridge', () => {
  it('exposes a stable bridge identity in stub mode', async () => {
    const bridge = createScreenCaptureBridge({ preferred_backend: 'stub' });
    const probe = await bridge.probe();
    expect(probe.bridge_id).toBe(SCREEN_CAPTURE_BRIDGE_ID);
    expect(probe.backend).toBe('stub');
    expect(probe.available).toBe(true);
  });

  it('captures a placeholder image in stub mode', async () => {
    const bridge = createScreenCaptureBridge({ preferred_backend: 'stub' });
    const outPath = path.join('active', 'shared', 'tmp', `screen-bridge-${Date.now()}.png`);
    const result = await bridge.captureScreenshot({
      save_path: outPath,
      capture_mode: 'focused_window',
      subject_hint: 'unit-test',
    });

    expect(result.bridge_id).toBe(SCREEN_CAPTURE_BRIDGE_ID);
    expect(result.backend).toBe('stub');
    expect(result.save_path).toContain('screen-bridge-');

    const buf = safeReadFile(outPath, { encoding: null }) as Buffer;
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(1, 4).toString('utf8')).toBe('PNG');
  });

  it('streams repeated screen frames in stub mode', async () => {
    const bridge = createScreenCaptureBridge({ preferred_backend: 'stub' });
    const frames = [];
    for await (const frame of bridge.captureStream({ max_frames: 2, frame_interval_ms: 0 })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(expect.objectContaining({
      format: expect.objectContaining({
        mime_type: 'image/png',
      }),
    }));
    expect(frames[0].payload.byteLength).toBeGreaterThan(0);
  });

  it('pipes screen frames into a video frame bus', async () => {
    const bridge = createScreenCaptureBridge({ preferred_backend: 'stub' });
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
