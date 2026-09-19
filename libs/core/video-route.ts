import type { VideoFormat, VideoFrame } from './meeting-session-types.js';

export interface VideoDeviceDescriptor {
  uid: string;
  display_name: string;
  direction: 'input' | 'output' | 'duplex';
  width?: number;
  height?: number;
  fps?: number;
  is_virtual: boolean;
  transport?: string;
}

export interface VideoBufferPolicy {
  max_frames: number;
  max_buffer_ms: number;
  overflow: 'drop_oldest' | 'drop_newest' | 'fail';
}

export interface VideoRouteHealth {
  status: 'healthy' | 'degraded' | 'failed' | 'closed';
  input_process_alive: boolean;
  output_process_alive: boolean;
  last_input_frame_at_ms?: number;
  last_output_frame_at_ms?: number;
  queue_depth: number;
  dropped_frames: number;
  underrun_count: number;
  device_disconnected: boolean;
  lease_held: boolean;
  reason?: string;
}

export interface VideoRouteMetrics {
  frames_in: number;
  frames_out: number;
  dropped_frames: number;
  dropped_ms: number;
  underrun_count: number;
  scaled: boolean;
}

export interface VideoRouteProbe {
  route_id: string;
  bus_id: string;
  available: boolean;
  reason?: string;
  input_device?: VideoDeviceDescriptor;
  output_device?: VideoDeviceDescriptor;
  devices?: VideoDeviceDescriptor[];
}

export interface VideoOutputPort {
  readonly port_id: string;
  probe(): Promise<VideoRouteProbe>;
  open(format: VideoFormat, device: VideoDeviceDescriptor): Promise<VideoFormat>;
  write(frame: VideoFrame): Promise<void>;
  close(): Promise<void>;
  health(): VideoRouteHealth;
  metrics(): VideoRouteMetrics;
}

export interface VideoInputPort {
  readonly port_id: string;
  frameStream(): AsyncIterable<VideoFrame>;
}

export interface DuplexVideoRoute {
  readonly route_id: string;
  probe(): Promise<VideoRouteProbe>;
  acquire(format: VideoFormat, signal?: AbortSignal): Promise<DuplexVideoSession>;
}

export interface DuplexVideoSession {
  readonly input: AsyncIterable<VideoFrame>;
  writeOutput(frames: AsyncIterable<VideoFrame>): Promise<void>;
  health(): VideoRouteHealth;
  metrics(): VideoRouteMetrics;
  close(): Promise<void>;
}

export function sameVideoFormat(left: VideoFormat, right: VideoFormat): boolean {
  if (left.mime_type !== right.mime_type) return false;
  if (left.width !== undefined && right.width !== undefined && left.width !== right.width) {
    return false;
  }
  if (left.height !== undefined && right.height !== undefined && left.height !== right.height) {
    return false;
  }
  return true;
}

export function estimateFrameDurationMs(frame: VideoFrame, fallbackFps = 30): number {
  void frame;
  const fps = Number.isFinite(fallbackFps) && fallbackFps > 0 ? fallbackFps : 30;
  return Math.max(1, Math.round(1000 / fps));
}
