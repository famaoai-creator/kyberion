import { describe, expect, it } from 'vitest';
import { StubVideoFrameBus } from './video-frame-bus.js';

describe('StubVideoFrameBus', () => {
  it('loops back written frames to the frame stream', async () => {
    const bus = new StubVideoFrameBus();
    const frames: Array<{ ts_ms: number; bytes: number }> = [];
    const reader = (async () => {
      for await (const frame of bus.frameStream()) {
        frames.push({ ts_ms: frame.ts_ms, bytes: frame.payload.byteLength });
      }
    })();

    await bus.writeFrames(
      (async function* () {
        yield {
          format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
          payload: new Uint8Array([1, 2, 3, 4]),
          ts_ms: 0,
        };
        yield {
          format: { mime_type: 'image/jpeg' as const, width: 640, height: 480 },
          payload: new Uint8Array([5, 6, 7, 8]),
          ts_ms: 33,
        };
      })(),
    );

    await bus.close();
    await reader;

    expect(frames).toEqual([
      { ts_ms: 0, bytes: 4 },
      { ts_ms: 33, bytes: 4 },
    ]);
  });
});

