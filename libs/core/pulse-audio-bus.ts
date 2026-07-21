/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * PulseAudio AudioBus (Linux container).
 *
 * Designed for the headless / container deployment shape: a Docker
 * image with PulseAudio running, and the bot's Chromium instance
 * connecting to it. We declare two virtual sinks with `pactl`:
 *
 *   meeting_in   — Chrome's microphone source (we write TTS here)
 *   meeting_out  — Chrome's speaker sink (we read meeting audio here)
 *
 * The bot's Chrome is configured to use `meeting_in` as its input
 * device and to play to `meeting_out`; both are easy to set via
 * `--audio-input` / `PULSE_SOURCE` / `PULSE_SINK` env vars.
 *
 * The implementation here is the bus side only — it sets up the
 * pulseaudio modules on `open`, spawns ffmpeg to read from the sink
 * monitor and write to the source, and tears them down on `close`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from './core.js';
import { buildSafeExecEnv, safeExec } from './secure-io.js';
import { registerEnvironmentCapabilityProbe } from './environment-capability.js';
import type { AudioBus, AudioBusProbe } from './audio-bus.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import { BoundedAudioQueue, DEFAULT_AUDIO_BUFFER_POLICY } from './bounded-audio-queue.js';
import type { AudioBufferPolicy, AudioRouteHealth, AudioRouteMetrics } from './audio-route.js';

export interface PulseAudioBusOptions {
  /** Source name we expose to the meeting client as its mic. */
  source_name?: string;
  /** Sink name the meeting client should play into. */
  sink_name?: string;
  ffmpeg_bin?: string;
  pactl_bin?: string;
  buffer_policy?: AudioBufferPolicy;
}

const DEFAULTS: Required<Pick<PulseAudioBusOptions, 'source_name' | 'sink_name'>> = {
  source_name: 'meeting_in',
  sink_name: 'meeting_out',
};

export class PulseAudioBus implements AudioBus {
  readonly bus_id = 'pulseaudio' as const;
  private readonly source: string;
  private readonly sink: string;
  private readonly ffmpegBin: string;
  private readonly pactlBin: string;
  private inputProc: ChildProcess | null = null;
  private outputProc: ChildProcess | null = null;
  private moduleIds: number[] = [];
  private opened = false;
  private closed = false;
  private format: AudioFormat | null = null;
  private readonly inboundQueue: BoundedAudioQueue;
  private status: AudioRouteHealth['status'] = 'closed';
  private reason: string | undefined;
  private readonly metricsValue: AudioRouteMetrics = {
    audio_chunks_in: 0,
    audio_chunks_out: 0,
    dropped_chunks: 0,
    dropped_ms: 0,
    underrun_count: 0,
    resampled: false,
  };

  constructor(opts: PulseAudioBusOptions = {}) {
    this.source = opts.source_name ?? DEFAULTS.source_name;
    this.sink = opts.sink_name ?? DEFAULTS.sink_name;
    this.ffmpegBin = opts.ffmpeg_bin ?? 'ffmpeg';
    this.pactlBin = opts.pactl_bin ?? 'pactl';
    this.inboundQueue = new BoundedAudioQueue(opts.buffer_policy ?? DEFAULT_AUDIO_BUFFER_POLICY);
  }

  async probe(): Promise<AudioBusProbe> {
    if (process.platform !== 'linux') {
      return {
        bus_id: 'pulseaudio',
        available: false,
        reason: `pulseaudio bus requires Linux; current platform is ${process.platform}`,
      };
    }
    try {
      safeExec(this.pactlBin, ['info']);
      return {
        bus_id: 'pulseaudio',
        available: true,
        devices: { input: this.source, output: this.sink },
      };
    } catch (err: any) {
      return {
        bus_id: 'pulseaudio',
        available: false,
        reason: `pactl info failed (is PulseAudio running?): ${err?.message ?? err}`,
      };
    }
  }

  async open(format: AudioFormat): Promise<void> {
    if (this.opened) return;
    if (format.encoding !== 'pcm_s16le') {
      throw new Error(
        `[pulse-audio-bus] only pcm_s16le is supported in this driver; got ${format.encoding}`
      );
    }
    const probe = await this.probe();
    if (!probe.available) throw new Error(`[pulse-audio-bus] not available: ${probe.reason}`);
    this.format = format;

    // 1. Create the virtual sink the meeting client will play into.
    const sinkArgs = [
      'load-module',
      'module-null-sink',
      `sink_name=${this.sink}`,
      `sink_properties=device.description=${this.sink}`,
    ];
    const sinkId = Number((safeExec(this.pactlBin, sinkArgs) as string).trim());
    if (!Number.isNaN(sinkId)) this.moduleIds.push(sinkId);

    // 2. Create the virtual source the meeting client uses as a mic.
    const srcArgs = [
      'load-module',
      'module-null-sink',
      `sink_name=${this.source}`,
      `sink_properties=device.description=${this.source}`,
    ];
    const srcId = Number((safeExec(this.pactlBin, srcArgs) as string).trim());
    if (!Number.isNaN(srcId)) this.moduleIds.push(srcId);

    const channels = String(format.channels);
    const rate = String(format.sample_rate_hz);

    // Input: read what the meeting client is playing into `${this.sink}`
    // (the .monitor source).
    this.inputProc = spawn(
      this.ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'pulse',
        '-i',
        `${this.sink}.monitor`,
        '-ac',
        channels,
        '-ar',
        rate,
        '-f',
        's16le',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: buildSafeExecEnv(), detached: true }
    );
    this.inputProc.stdout?.on('data', (buf: Buffer) => this.handleInbound(buf));
    this.inputProc.on('error', (error) => {
      this.status = 'degraded';
      this.reason = error.message;
    });
    this.inputProc.on('exit', (code) => {
      logger.info(`[pulse-audio-bus] input ffmpeg exited with code ${code}`);
      if (!this.closed) {
        this.status = 'degraded';
        this.reason = `input process exited code=${String(code)}`;
      }
      this.inboundQueue.close();
    });

    // Output: write s16le into the source sink so the client picks it up.
    this.outputProc = spawn(
      this.ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ac',
        channels,
        '-ar',
        rate,
        '-i',
        'pipe:0',
        '-f',
        'pulse',
        this.source,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], env: buildSafeExecEnv(), detached: true }
    );
    this.outputProc.on('error', (error) => {
      this.status = 'degraded';
      this.reason = error.message;
    });
    this.outputProc.on('exit', (code) => {
      logger.info(`[pulse-audio-bus] output ffmpeg exited with code ${code}`);
      if (!this.closed && code !== 0) {
        this.status = 'degraded';
        this.reason = `output process exited code=${String(code)}`;
      }
    });

    this.opened = true;
    this.status = 'healthy';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.inputProc?.kill('SIGTERM');
      this.outputProc?.stdin?.end();
      this.outputProc?.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    for (const id of this.moduleIds.reverse()) {
      try {
        safeExec(this.pactlBin, ['unload-module', String(id)]);
      } catch (err: any) {
        logger.warn(`[pulse-audio-bus] unload-module ${id} failed: ${err?.message ?? err}`);
      }
    }
    this.moduleIds = [];
    this.inboundQueue.close();
  }

  async *inputStream(): AsyncIterable<AudioChunk> {
    if (!this.opened) throw new Error('[pulse-audio-bus] open() before reading inputStream');
    while (!this.closed) {
      const chunk = await this.inboundQueue.next();
      if (chunk === null) return;
      this.metricsValue.audio_chunks_in += 1;
      yield chunk;
    }
  }

  async writeOutput(stream: AsyncIterable<AudioChunk>): Promise<void> {
    if (!this.opened || !this.outputProc) {
      throw new Error('[pulse-audio-bus] open() before writeOutput');
    }
    for await (const chunk of stream) {
      if (this.closed) return;
      if (
        chunk.format.encoding !== this.format?.encoding ||
        chunk.format.sample_rate_hz !== this.format?.sample_rate_hz ||
        chunk.format.channels !== this.format?.channels
      )
        throw new Error('[pulse-audio-bus] output PCM format mismatch');
      if (this.outputProc.stdin && !this.outputProc.stdin.write(Buffer.from(chunk.payload)))
        await onceDrain(this.outputProc.stdin);
      this.metricsValue.audio_chunks_out += 1;
    }
  }

  private handleInbound(buf: Buffer): void {
    if (!this.format) return;
    const chunk: AudioChunk = {
      format: this.format,
      payload: new Uint8Array(buf),
      ts_ms: Date.now(),
    };
    this.inboundQueue.push(chunk);
  }

  health(): AudioRouteHealth {
    return {
      status: this.closed ? 'closed' : this.status,
      input_process_alive: Boolean(this.inputProc && this.inputProc.exitCode === null),
      output_process_alive: Boolean(this.outputProc && this.outputProc.exitCode === null),
      queue_depth: this.inboundQueue.metrics().depth,
      dropped_chunks: this.inboundQueue.metrics().dropped_chunks,
      underrun_count: 0,
      device_disconnected: this.status === 'degraded',
      lease_held: this.opened && !this.closed,
      ...(this.reason ? { reason: this.reason } : {}),
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

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

registerEnvironmentCapabilityProbe('audio-bus.pulseaudio', async () => {
  return new PulseAudioBus().probe();
});
