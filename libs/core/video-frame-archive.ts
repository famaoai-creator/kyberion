import * as path from 'node:path';
import { safeExec, safeMkdir, safeReadFile, safeReaddir, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type { VideoFrame, VideoFormat } from './meeting-session-types.js';
import type { VideoFrameBus } from './video-frame-bus.js';

export interface VideoFrameArchiveOptions {
  ffmpeg_bin?: string;
  fps?: number;
  cleanup?: boolean;
}

export interface VideoFrameArchiveResult {
  output_path: string;
  frame_count: number;
  fps: number;
  format: VideoFormat;
}

const DEFAULT_FFMPEG_BIN = 'ffmpeg';

function normalizeFps(frames: VideoFrame[], requested?: number): number {
  if (requested && Number.isFinite(requested) && requested > 0) {
    return Math.max(1, Math.min(120, Math.round(requested)));
  }
  if (frames.length < 2) return 30;
  const deltas: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const delta = frames[index].ts_ms - frames[index - 1].ts_ms;
    if (Number.isFinite(delta) && delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return 30;
  const avgDelta = deltas.reduce((total, value) => total + value, 0) / deltas.length;
  if (!Number.isFinite(avgDelta) || avgDelta <= 0) return 30;
  return Math.max(1, Math.min(120, Math.round(1000 / avgDelta)));
}

function frameFileExtension(format: VideoFormat): 'jpg' | 'png' {
  return format.mime_type === 'image/png' ? 'png' : 'jpg';
}

function resolveArchiveTempDir(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return pathResolver.sharedTmp(path.join('video-frame-archive', `${prefix}-${stamp}`));
}

async function collectFrames(stream: AsyncIterable<VideoFrame>): Promise<VideoFrame[]> {
  const frames: VideoFrame[] = [];
  for await (const frame of stream) {
    frames.push(frame);
  }
  return frames;
}

export async function writeVideoFramesToMp4(
  outputPath: string,
  framesStream: AsyncIterable<VideoFrame>,
  options: VideoFrameArchiveOptions = {},
): Promise<VideoFrameArchiveResult> {
  const frames = await collectFrames(framesStream);
  if (frames.length === 0) {
    throw new Error('[video-frame-archive] no frames provided for mp4 encoding');
  }
  const firstFormat = frames[0].format;
  if (firstFormat.mime_type !== 'image/jpeg' && firstFormat.mime_type !== 'image/png') {
    throw new Error(`[video-frame-archive] unsupported frame format: ${firstFormat.mime_type}`);
  }
  for (const frame of frames) {
    if (frame.format.mime_type !== firstFormat.mime_type) {
      throw new Error('[video-frame-archive] mixed frame mime types are not supported');
    }
  }

  const ffmpegBin = options.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
  const fps = normalizeFps(frames, options.fps);
  const tempDir = resolveArchiveTempDir('encode');
  const ext = frameFileExtension(firstFormat);
  safeMkdir(tempDir, { recursive: true });
  safeMkdir(path.dirname(outputPath), { recursive: true });

  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const framePath = path.join(tempDir, `frame-${String(index + 1).padStart(6, '0')}.${ext}`);
      safeWriteFile(framePath, Buffer.from(frame.payload));
    }

    const inputPattern = path.join(tempDir, `frame-%06d.${ext}`);
    safeExec(
      ffmpegBin,
      [
        '-y',
        '-framerate',
        String(fps),
        '-i',
        inputPattern,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { env: process.env, timeoutMs: 120_000 },
    );

    return {
      output_path: outputPath,
      frame_count: frames.length,
      fps,
      format: firstFormat,
    };
  } finally {
    if (options.cleanup !== false) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function* readVideoFramesFromMp4(
  inputPath: string,
  options: VideoFrameArchiveOptions = {},
): AsyncIterable<VideoFrame> {
  const ffmpegBin = options.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
  const tempDir = resolveArchiveTempDir('decode');
  const fps = Math.max(1, Math.min(120, Math.round(options.fps || 30)));
  safeMkdir(tempDir, { recursive: true });

  try {
    const outputPattern = path.join(tempDir, 'frame-%06d.jpg');
    safeExec(
      ffmpegBin,
      [
        '-y',
        '-i',
        inputPath,
        '-vf',
        `fps=${fps}`,
        outputPattern,
      ],
      { env: process.env, timeoutMs: 120_000 },
    );

    const files = (safeReaddir(tempDir) || [])
      .filter((entry) => /\.jpe?g$/i.test(entry) || /\.png$/i.test(entry))
      .sort();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const filePath = path.join(tempDir, file);
      const payload = safeReadFile(filePath, { encoding: null });
      const payloadBytes = Buffer.isBuffer(payload)
        ? new Uint8Array(payload)
        : new Uint8Array(Buffer.from(payload));
      yield {
        format: { mime_type: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg' },
        payload: payloadBytes,
        ts_ms: Math.round((index * 1000) / fps),
      };
    }
  } finally {
    if (options.cleanup !== false) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function writeVideoFrameBusToMp4(
  bus: VideoFrameBus,
  outputPath: string,
  options: VideoFrameArchiveOptions = {},
): Promise<VideoFrameArchiveResult> {
  return writeVideoFramesToMp4(outputPath, bus.frameStream(), options);
}

export async function pipeMp4ToVideoFrameBus(
  inputPath: string,
  bus: VideoFrameBus,
  options: VideoFrameArchiveOptions = {},
): Promise<void> {
  await bus.writeFrames(readVideoFramesFromMp4(inputPath, options));
}
