import type { AudioChunk, AudioFormat } from './meeting-session-types.js';

export interface AudioDeviceDescriptor {
  uid: string;
  display_name: string;
  direction: 'input' | 'output' | 'duplex';
  channel_count?: number;
  supported_sample_rates?: number[];
  is_virtual: boolean;
  transport?: string;
  avfoundation_unique_id?: string;
}

export interface AudioBufferPolicy {
  max_chunks: number;
  max_buffer_ms: number;
  overflow: 'drop_oldest' | 'drop_newest' | 'fail';
}

export interface AudioRouteHealth {
  status: 'healthy' | 'degraded' | 'failed' | 'closed';
  input_process_alive: boolean;
  output_process_alive: boolean;
  last_input_chunk_at_ms?: number;
  last_output_chunk_at_ms?: number;
  queue_depth: number;
  dropped_chunks: number;
  underrun_count: number;
  device_disconnected: boolean;
  lease_held: boolean;
  reason?: string;
}

export interface AudioRouteMetrics {
  audio_chunks_in: number;
  audio_chunks_out: number;
  dropped_chunks: number;
  dropped_ms: number;
  underrun_count: number;
  input_peak_rms?: number;
  output_peak_rms?: number;
  clipping_ratio?: number;
  silence_ratio?: number;
  resampled: boolean;
}

export interface AudioRouteProbe {
  route_id: string;
  bus_id: 'blackhole' | 'pulseaudio' | 'vendor-sdk' | 'stub';
  available: boolean;
  reason?: string;
  input_device?: AudioDeviceDescriptor;
  output_device?: AudioDeviceDescriptor;
  devices?: AudioDeviceDescriptor[];
}

export interface AudioOutputPort {
  readonly port_id: string;
  probe(): Promise<AudioRouteProbe>;
  open(format: AudioFormat, device: AudioDeviceDescriptor): Promise<AudioFormat>;
  write(chunk: AudioChunk): Promise<void>;
  close(): Promise<void>;
  health(): AudioRouteHealth;
  metrics(): AudioRouteMetrics;
}

export interface AudioInputPort {
  readonly port_id: string;
  inputStream(): AsyncIterable<AudioChunk>;
}

export interface DuplexAudioRoute {
  readonly route_id: string;
  probe(): Promise<AudioRouteProbe>;
  acquire(format: AudioFormat, signal?: AbortSignal): Promise<DuplexAudioSession>;
}

export interface DuplexAudioSession {
  readonly input: AsyncIterable<AudioChunk>;
  writeOutput(audio: AsyncIterable<AudioChunk>): Promise<void>;
  health(): AudioRouteHealth;
  metrics(): AudioRouteMetrics;
  close(): Promise<void>;
}

export function bytesPerSample(format: AudioFormat): number {
  if (format.encoding === 'pcm_s16le') return 2;
  if (format.encoding === 'pcm_f32le') return 4;
  return 1;
}

export function chunkDurationMs(chunk: AudioChunk): number {
  const frames = chunk.payload.byteLength / (bytesPerSample(chunk.format) * chunk.format.channels);
  return (frames * 1000) / chunk.format.sample_rate_hz;
}

export function pcmSignalMetrics(
  chunks: readonly AudioChunk[]
): Pick<AudioRouteMetrics, 'input_peak_rms' | 'clipping_ratio' | 'silence_ratio'> {
  let sampleCount = 0;
  let clipped = 0;
  let silent = 0;
  let peakRms = 0;
  for (const chunk of chunks) {
    if (chunk.format.encoding !== 'pcm_s16le') continue;
    const view = new DataView(
      chunk.payload.buffer,
      chunk.payload.byteOffset,
      chunk.payload.byteLength
    );
    const samples = Math.floor(chunk.payload.byteLength / 2);
    let sumSquares = 0;
    for (let index = 0; index < samples; index += 1) {
      const sample = view.getInt16(index * 2, true);
      const magnitude = Math.abs(sample);
      sumSquares += sample * sample;
      if (magnitude >= 32760) clipped += 1;
      sampleCount += 1;
    }
    const rms = samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
    peakRms = Math.max(peakRms, rms);
    if (rms < 64) silent += samples;
  }
  return {
    input_peak_rms: sampleCount > 0 ? peakRms : undefined,
    clipping_ratio: sampleCount > 0 ? clipped / sampleCount : undefined,
    silence_ratio: sampleCount > 0 ? silent / sampleCount : undefined,
  };
}
