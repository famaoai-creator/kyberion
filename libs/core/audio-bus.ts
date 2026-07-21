/**
 * AudioBus — the OS-level boundary between the meeting client (Chrome,
 * vendor SDK) and our STT / TTS pipeline.
 *
 * Macro: every participant flow needs to (a) receive what the meeting
 * is saying as a steady stream of PCM frames so STT can transcribe
 * it, and (b) inject what the AI wants to say back into the meeting's
 * mic input. The bus is the abstraction over that wiring; concrete
 * implementations route via virtual audio devices (BlackHole / Loopback
 * on macOS, PulseAudio null-sinks on Linux, or vendor-SDK PCM streams
 * when available).
 *
 * The interface is intentionally tiny: callers only ever see two
 * async iterables. Capability discovery happens via `probe()` — the
 * coordinator can ask "is BlackHole installed?" before committing to
 * a real run. A `StubAudioBus` (in-memory loopback) lets the rest of
 * the system be tested without any device dependency.
 */

import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import { BoundedAudioQueue, DEFAULT_AUDIO_BUFFER_POLICY } from './bounded-audio-queue.js';
import type {
  AudioBufferPolicy,
  AudioDeviceDescriptor,
  AudioRouteHealth,
  AudioRouteMetrics,
} from './audio-route.js';

export interface AudioBusProbe {
  /** Stable id to distinguish implementations in logs / audit. */
  bus_id: 'blackhole' | 'pulseaudio' | 'vendor-sdk' | 'stub';
  /** True when the bus can wire real audio in/out on this host. */
  available: boolean;
  /** Human-readable diagnostic when `available=false`. */
  reason?: string;
  /** Devices the bus discovered (driver name / index). */
  devices?: { input?: string; output?: string };
  device_descriptors?: AudioDeviceDescriptor[];
  warnings?: string[];
}

export interface AudioBus {
  readonly bus_id: AudioBusProbe['bus_id'];
  /** Capability check; never throws. */
  probe(): Promise<AudioBusProbe>;
  /**
   * Open the bus. Allocates virtual devices / loads kernel modules /
   * negotiates format with the meeting client. Idempotent.
   */
  open(format: AudioFormat): Promise<void>;
  /** Audio coming FROM the meeting (other participants → STT). */
  inputStream(): AsyncIterable<AudioChunk>;
  /** Audio going TO the meeting (TTS → meeting mic). */
  writeOutput(stream: AsyncIterable<AudioChunk>): Promise<void>;
  /** Tear down virtual devices / loopbacks. Idempotent. */
  close(): Promise<void>;
  health?(): AudioRouteHealth;
  metrics?(): AudioRouteMetrics;
}

/* ------------------------------------------------------------------ *
 * StubAudioBus — pure in-memory loopback for tests and dry runs.
 *
 * Anything written to `writeOutput` is buffered and yielded on the
 * next pull from `inputStream`. That gives a coordinator a chance to
 * exercise the full agent loop without touching any real device.
 * ------------------------------------------------------------------ */

export class StubAudioBus implements AudioBus {
  readonly bus_id = 'stub' as const;
  private opened = false;
  private readonly inboundQueue: BoundedAudioQueue;
  private readonly metricsValue: AudioRouteMetrics = {
    audio_chunks_in: 0,
    audio_chunks_out: 0,
    dropped_chunks: 0,
    dropped_ms: 0,
    underrun_count: 0,
    resampled: false,
  };
  private closed = false;

  constructor(policy: AudioBufferPolicy = DEFAULT_AUDIO_BUFFER_POLICY) {
    this.inboundQueue = new BoundedAudioQueue(policy);
  }

  async probe(): Promise<AudioBusProbe> {
    return { bus_id: 'stub', available: true };
  }

  async open(_format: AudioFormat): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.inboundQueue.close();
  }

  /** Test helper: feed an external chunk into `inputStream`. */
  injectInbound(chunk: AudioChunk): void {
    this.inboundQueue.push(chunk);
  }

  async *inputStream(): AsyncIterable<AudioChunk> {
    if (!this.opened) throw new Error('[stub-audio-bus] open() before reading inputStream');
    while (!this.closed) {
      const chunk = await this.inboundQueue.next();
      if (chunk === null) return;
      this.metricsValue.audio_chunks_in += 1;
      yield chunk;
    }
  }

  async writeOutput(stream: AsyncIterable<AudioChunk>): Promise<void> {
    for await (const chunk of stream) {
      // Loopback so the coordinator's TTS output appears as inbound.
      this.injectInbound(chunk);
      this.metricsValue.audio_chunks_out += 1;
    }
  }

  health(): AudioRouteHealth {
    const queue = this.inboundQueue.metrics();
    return {
      status: this.closed ? 'closed' : 'healthy',
      input_process_alive: !this.closed,
      output_process_alive: !this.closed,
      queue_depth: queue.depth,
      dropped_chunks: queue.dropped_chunks,
      underrun_count: 0,
      device_disconnected: false,
      lease_held: this.opened && !this.closed,
    };
  }

  metrics(): AudioRouteMetrics {
    const queue = this.inboundQueue.metrics();
    return {
      ...this.metricsValue,
      dropped_chunks: queue.dropped_chunks,
      dropped_ms: queue.dropped_ms,
    };
  }
}
