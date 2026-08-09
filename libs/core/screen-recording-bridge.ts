import * as path from 'node:path';
import type { ScreenCaptureBridge, ScreenCaptureStreamRequest } from './screen-capture-bridge.js';
import { createScreenCaptureBridge } from './screen-capture-bridge.js';
import {
  writeVideoFramesToMp4,
  type VideoFrameArchiveOptions,
  type VideoFrameArchiveResult,
} from './video-frame-archive.js';
import type { VideoFrame } from './meeting-session-types.js';

export const SCREEN_RECORDING_BRIDGE_ID = 'screen-recording-bridge' as const;

export interface ScreenRecordingBridgeOptions {
  capture_bridge?: ScreenCaptureBridge;
  fps?: number;
  /** Required: raw screen frames must be sanitized before entering the archive. */
  frame_redactor?: (frame: VideoFrame) => Promise<VideoFrame>;
}

export interface ScreenRecordingBridgeProbe {
  bridge_id: typeof SCREEN_RECORDING_BRIDGE_ID;
  available: boolean;
  platform: NodeJS.Platform;
  capture_bridge?: Awaited<ReturnType<ScreenCaptureBridge['probe']>>;
}

export interface ScreenRecordingBridge {
  readonly bridge_id: typeof SCREEN_RECORDING_BRIDGE_ID;
  probe(): Promise<ScreenRecordingBridgeProbe>;
  recordToMp4(
    outputPath: string,
    input?: ScreenCaptureStreamRequest & VideoFrameArchiveOptions
  ): Promise<VideoFrameArchiveResult>;
}

export class ScreenRecordingBridgeImpl implements ScreenRecordingBridge {
  readonly bridge_id = SCREEN_RECORDING_BRIDGE_ID;

  constructor(private readonly opts: ScreenRecordingBridgeOptions = {}) {}

  private get captureBridge(): ScreenCaptureBridge {
    return this.opts.capture_bridge ?? createScreenCaptureBridge();
  }

  async probe(): Promise<ScreenRecordingBridgeProbe> {
    const captureProbe = await this.captureBridge.probe();
    return {
      bridge_id: SCREEN_RECORDING_BRIDGE_ID,
      available: captureProbe.available,
      platform: process.platform,
      capture_bridge: captureProbe,
    };
  }

  async recordToMp4(
    outputPath: string,
    input: ScreenCaptureStreamRequest & VideoFrameArchiveOptions = {}
  ): Promise<VideoFrameArchiveResult> {
    if (!this.opts.frame_redactor) {
      throw new Error(
        'screen recording requires a frame redactor; raw screen frames are never archived'
      );
    }
    const captureInput: ScreenCaptureStreamRequest = {
      display_index: input.display_index,
      capture_mode: input.capture_mode,
      subject_hint: input.subject_hint,
      max_frames: input.max_frames,
      frame_interval_ms: input.frame_interval_ms,
    };
    const redactedFrames = this.redactFrames(this.captureBridge.captureStream(captureInput));
    return writeVideoFramesToMp4(path.resolve(outputPath), redactedFrames, {
      fps: input.fps ?? this.opts.fps,
      cleanup: input.cleanup,
      ffmpeg_bin: input.ffmpeg_bin,
    });
  }

  private async *redactFrames(stream: AsyncIterable<VideoFrame>): AsyncIterable<VideoFrame> {
    for await (const frame of stream) {
      const redacted = await this.opts.frame_redactor!(frame);
      if (!redacted || redacted.payload.byteLength === 0)
        throw new Error('screen frame redactor withheld a frame');
      yield redacted;
    }
  }
}

export function createScreenRecordingBridge(
  opts: ScreenRecordingBridgeOptions = {}
): ScreenRecordingBridge {
  return new ScreenRecordingBridgeImpl(opts);
}
