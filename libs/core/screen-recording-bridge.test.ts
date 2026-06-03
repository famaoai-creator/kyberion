import { describe, expect, it, vi } from 'vitest';

vi.mock('./video-frame-archive.js', () => ({
  writeVideoFramesToMp4: vi.fn(async (outputPath: string, frames: AsyncIterable<any>, options: any) => {
    const collected: any[] = [];
    for await (const frame of frames) {
      collected.push(frame);
    }
    return {
      output_path: outputPath,
      frame_count: collected.length,
      fps: options?.fps ?? 24,
      format: collected[0]?.format ?? { mime_type: 'image/png' as const, width: 1280, height: 720 },
    };
  }),
}));

import { createScreenRecordingBridge } from './screen-recording-bridge.js';

describe('createScreenRecordingBridge', () => {
  it('records a capture stream to mp4', async () => {
    const bridge = createScreenRecordingBridge({
      capture_bridge: {
        bridge_id: 'screen-capture-bridge',
        probe: vi.fn(async () => ({
          bridge_id: 'screen-capture-bridge',
          platform: 'darwin',
          backend: 'stub',
          available: true,
        })),
        captureScreenshot: vi.fn(),
        captureStream: async function* () {
          yield {
            format: { mime_type: 'image/png' as const, width: 1280, height: 720 },
            payload: new Uint8Array([1, 2, 3]),
            ts_ms: 0,
          };
          yield {
            format: { mime_type: 'image/png' as const, width: 1280, height: 720 },
            payload: new Uint8Array([4, 5, 6]),
            ts_ms: 250,
          };
        },
        pipeTo: vi.fn(),
      },
      fps: 12,
    });

    const result = await bridge.recordToMp4('active/shared/tmp/screen-recording-test.mp4', {
      max_frames: 2,
      frame_interval_ms: 0,
    });

    expect(result.output_path).toContain('screen-recording-test.mp4');
    expect(result.frame_count).toBe(2);
    expect(result.fps).toBe(12);
  });
});
