import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pathResolver } from './path-resolver.js';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeLstat: vi.fn(() => ({ isFile: () => true })),
  safeMkdir: vi.fn(),
  safeReadFile: vi.fn(() => Buffer.from([1, 2, 3])),
  safeReaddir: vi.fn(() => ['frame-000001.jpg', 'frame-000002.jpg']),
  safeRmSync: vi.fn(),
  safeWriteFile: vi.fn(),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    assertSafeRepositoryPath: (filePath: string, options: { allowMissingLeaf?: boolean } = {}) =>
      filePath.includes('/video-frame-archive/') && options.allowMissingLeaf !== true
        ? filePath
        : actual.assertSafeRepositoryPath(filePath, options),
    safeExec: mocks.safeExec,
    safeLstat: mocks.safeLstat,
    safeMkdir: mocks.safeMkdir,
    safeReadFile: mocks.safeReadFile,
    safeReaddir: mocks.safeReaddir,
    safeRmSync: mocks.safeRmSync,
    safeWriteFile: mocks.safeWriteFile,
  };
});

describe('video-frame-archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes frames to mp4 via ffmpeg', async () => {
    const { writeVideoFramesToMp4 } = await import('./video-frame-archive.js');
    const outputPath = pathResolver.sharedTmp('video-frame-archive-tests/out.mp4');
    const result = await writeVideoFramesToMp4(
      outputPath,
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
      { fps: 30 }
    );

    expect(result.output_path).toBe(outputPath);
    expect(result.frame_count).toBe(2);
    expect(mocks.safeWriteFile).toHaveBeenCalledTimes(2);
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-framerate', '30', outputPath]),
      expect.objectContaining({ timeoutMs: 120000 })
    );
  });

  it('reads mp4 frames back into video frames', async () => {
    const { readVideoFramesFromMp4 } = await import('./video-frame-archive.js');
    const inputPath = pathResolver.sharedTmp('video-frame-archive-tests/in.mp4');
    const frames: Array<{ mime_type: string; bytes: number }> = [];
    for await (const frame of readVideoFramesFromMp4(inputPath, { fps: 24 })) {
      frames.push({ mime_type: frame.format.mime_type, bytes: frame.payload.byteLength });
    }

    expect(frames).toEqual([
      { mime_type: 'image/jpeg', bytes: 3 },
      { mime_type: 'image/jpeg', bytes: 3 },
    ]);
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-i', inputPath, '-vf', 'fps=24']),
      expect.objectContaining({ timeoutMs: 120000 })
    );
  });

  it('rejects archive paths outside the repository', async () => {
    const { writeVideoFramesToMp4, readVideoFramesFromMp4 } =
      await import('./video-frame-archive.js');
    const frames = (async function* () {
      yield {
        format: { mime_type: 'image/jpeg' as const, width: 1, height: 1 },
        payload: new Uint8Array([1, 2, 3]),
        ts_ms: 0,
      };
    })();

    await expect(writeVideoFramesToMp4('/tmp/out.mp4', frames)).rejects.toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    await expect(async () => {
      for await (const _frame of readVideoFramesFromMp4('/tmp/in.mp4')) {
        // boundary check happens before the first yielded frame
      }
    }).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it('rejects an input video path replaced by a directory', async () => {
    const { readVideoFramesFromMp4 } = await import('./video-frame-archive.js');
    const inputPath = pathResolver.sharedTmp('video-frame-archive-tests/directory.mp4');
    mocks.safeLstat.mockImplementation((candidate: string) => ({
      isFile: () => !candidate.endsWith('/directory.mp4'),
    }));

    await expect(async () => {
      for await (const _frame of readVideoFramesFromMp4(inputPath)) {
        // The directory input must fail before ffmpeg is invoked.
      }
    }).rejects.toThrow('[VIDEO_FRAME_ARCHIVE_RESOURCE] input must be a regular file');
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });
});
