import * as path from 'node:path';
import type { ScreenCaptureBridge, ScreenCaptureStreamRequest } from './screen-capture-bridge.js';
import { createScreenCaptureBridge } from './screen-capture-bridge.js';
import { writeVideoFramesToMp4, type VideoFrameArchiveOptions, type VideoFrameArchiveResult } from './video-frame-archive.js';

export const SCREEN_RECORDING_BRIDGE_ID = 'screen-recording-bridge' as const;

export interface ScreenRecordingBridgeOptions {
  capture_bridge?: ScreenCaptureBridge;
  fps?: number;
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
  recordToMp4(outputPath: string, input?: ScreenCaptureStreamRequest & VideoFrameArchiveOptions): Promise<VideoFrameArchiveResult>;
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
    input: ScreenCaptureStreamRequest & VideoFrameArchiveOptions = {},
  ): Promise<VideoFrameArchiveResult> {
    const captureInput: ScreenCaptureStreamRequest = {
      display_index: input.display_index,
      capture_mode: input.capture_mode,
      subject_hint: input.subject_hint,
      max_frames: input.max_frames,
      frame_interval_ms: input.frame_interval_ms,
    };
    return writeVideoFramesToMp4(path.resolve(outputPath), this.captureBridge.captureStream(captureInput), {
      fps: input.fps ?? this.opts.fps,
      cleanup: input.cleanup,
      ffmpeg_bin: input.ffmpeg_bin,
    });
  }
}

export function createScreenRecordingBridge(opts: ScreenRecordingBridgeOptions = {}): ScreenRecordingBridge {
  return new ScreenRecordingBridgeImpl(opts);
}
