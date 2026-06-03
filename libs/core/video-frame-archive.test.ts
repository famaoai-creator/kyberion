import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeMkdir: vi.fn(),
  safeReadFile: vi.fn(() => Buffer.from([1, 2, 3])),
  safeReaddir: vi.fn(() => ['frame-000001.jpg', 'frame-000002.jpg']),
  safeRmSync: vi.fn(),
  safeWriteFile: vi.fn(),
}));

vi.mock('./secure-io.js', () => ({
  safeExec: mocks.safeExec,
  safeMkdir: mocks.safeMkdir,
  safeReadFile: mocks.safeReadFile,
  safeReaddir: mocks.safeReaddir,
  safeRmSync: mocks.safeRmSync,
  safeWriteFile: mocks.safeWriteFile,
}));

describe('video-frame-archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes frames to mp4 via ffmpeg', async () => {
    const { writeVideoFramesToMp4 } = await import('./video-frame-archive.js');
    const result = await writeVideoFramesToMp4(
      '/tmp/out.mp4',
      (async function* () {
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
      })(),
      { fps: 30 },
    );

    expect(result.output_path).toBe('/tmp/out.mp4');
    expect(result.frame_count).toBe(2);
    expect(mocks.safeWriteFile).toHaveBeenCalledTimes(2);
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-framerate', '30', '/tmp/out.mp4']),
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it('reads mp4 frames back into video frames', async () => {
    const { readVideoFramesFromMp4 } = await import('./video-frame-archive.js');
    const frames: Array<{ mime_type: string; bytes: number }> = [];
    for await (const frame of readVideoFramesFromMp4('/tmp/in.mp4', { fps: 24 })) {
      frames.push({ mime_type: frame.format.mime_type, bytes: frame.payload.byteLength });
    }

    expect(frames).toEqual([
      { mime_type: 'image/jpeg', bytes: 3 },
      { mime_type: 'image/jpeg', bytes: 3 },
    ]);
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-i', '/tmp/in.mp4', '-vf', 'fps=24']),
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });
});

