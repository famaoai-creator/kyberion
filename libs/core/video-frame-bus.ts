import type { VideoFrame, VideoFormat } from './meeting-session-types.js';

export const VIDEO_FRAME_BUS_ID = 'stub' as const;

export interface VideoFrameBusProbe {
  bus_id: typeof VIDEO_FRAME_BUS_ID;
  available: boolean;
  reason?: string;
  format?: VideoFormat;
  buffered_frames?: number;
}

export interface VideoFrameBus {
  readonly bus_id: typeof VIDEO_FRAME_BUS_ID;
  probe(): Promise<VideoFrameBusProbe>;
  frameStream(): AsyncIterable<VideoFrame>;
  writeFrames(stream: AsyncIterable<VideoFrame>): Promise<void>;
  close(): Promise<void>;
}

export class StubVideoFrameBus implements VideoFrameBus {
  readonly bus_id = VIDEO_FRAME_BUS_ID;
  private closed = false;
  private format?: VideoFormat;
  private bufferedFrames: VideoFrame[] = [];
  private resolvers: Array<(frame: VideoFrame | null) => void> = [];

  async probe(): Promise<VideoFrameBusProbe> {
    return {
      bus_id: VIDEO_FRAME_BUS_ID,
      available: true,
      format: this.format,
      buffered_frames: this.bufferedFrames.length,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver(null);
    }
  }

  private pushFrame(frame: VideoFrame): void {
    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver(frame);
      return;
    }
    this.bufferedFrames.push(frame);
  }

  async *frameStream(): AsyncIterable<VideoFrame> {
    while (!this.closed || this.bufferedFrames.length > 0) {
      if (this.bufferedFrames.length > 0) {
        yield this.bufferedFrames.shift()!;
        continue;
      }
      if (this.closed) return;
      const frame = await new Promise<VideoFrame | null>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (frame === null) return;
      yield frame;
    }
  }

  async writeFrames(stream: AsyncIterable<VideoFrame>): Promise<void> {
    for await (const frame of stream) {
      this.format = this.format ?? frame.format;
      this.pushFrame(frame);
    }
  }
}
