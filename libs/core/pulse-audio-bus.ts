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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from './core.js';
import { safeExec } from './secure-io.js';
import { registerEnvironmentCapabilityProbe } from './environment-capability.js';
import type { AudioBus, AudioBusProbe } from './audio-bus.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';

export interface PulseAudioBusOptions {
  /** Source name we expose to the meeting client as its mic. */
  source_name?: string;
  /** Sink name the meeting client should play into. */
  sink_name?: string;
  ffmpeg_bin?: string;
  pactl_bin?: string;
}

const DEFAULTS: Required<Omit<PulseAudioBusOptions, 'ffmpeg_bin' | 'pactl_bin'>> = {
  source_name: 'meeting_in',
  sink_name: 'meeting_out',
};

export class PulseAudioBus implements AudioBus {
  readonly bus_id = 'pulseaudio' as const;
  private readonly source: string;
  private readonly sink: string;
  private readonly ffmpegBin: string;
  private readonly pactlBin: string;
  private inputProc: ChildProcessWithoutNullStreams | null = null;
  private outputProc: ChildProcessWithoutNullStreams | null = null;
  private moduleIds: number[] = [];
  private opened = false;
  private closed = false;
  private format: AudioFormat | null = null;
  private inboundQueue: AudioChunk[] = [];
  private inboundResolvers: Array<(chunk: AudioChunk | null) => void> = [];

  constructor(opts: PulseAudioBusOptions = {}) {
    this.source = opts.source_name ?? DEFAULTS.source_name;
    this.sink = opts.sink_name ?? DEFAULTS.sink_name;
    this.ffmpegBin = opts.ffmpeg_bin ?? 'ffmpeg';
    this.pactlBin = opts.pactl_bin ?? 'pactl';
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
        `[pulse-audio-bus] only pcm_s16le is supported in this driver; got ${format.encoding}`,
      );
    }
    const probe = await this.probe();
    if (!probe.available) throw new Error(`[pulse-audio-bus] not available: ${probe.reason}`);
    this.format = format;

    // 1. Create the virtual sink the meeting client will play into.
    const sinkArgs = [
      'load-module', 'module-null-sink',
      `sink_name=${this.sink}`,
      `sink_properties=device.description=${this.sink}`,
    ];
    const sinkId = Number((safeExec(this.pactlBin, sinkArgs) as string).trim());
    if (!Number.isNaN(sinkId)) this.moduleIds.push(sinkId);

    // 2. Create the virtual source the meeting client uses as a mic.
    const srcArgs = [
      'load-module', 'module-null-sink',
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
        '-loglevel', 'error',
        '-f', 'pulse',
        '-i', `${this.sink}.monitor`,
        '-ac', channels,
        '-ar', rate,
        '-f', 's16le',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.inputProc.stdout.on('data', (buf: Buffer) => this.handleInbound(buf));
    this.inputProc.on('exit', (code) => {
      logger.info(`[pulse-audio-bus] input ffmpeg exited with code ${code}`);
      this.flushInboundDone();
    });

    // Output: write s16le into the source sink so the client picks it up.
    this.outputProc = spawn(
      this.ffmpegBin,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ac', channels,
        '-ar', rate,
        '-i', 'pipe:0',
        '-f', 'pulse',
        this.source,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    this.outputProc.on('exit', (code) => {
      logger.info(`[pulse-audio-bus] output ffmpeg exited with code ${code}`);
    });

    this.opened = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.inputProc?.kill('SIGTERM');
      this.outputProc?.stdin.end();
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
    this.flushInboundDone();
  }

  async *inputStream(): AsyncIterable<AudioChunk> {
    if (!this.opened) throw new Error('[pulse-audio-bus] open() before reading inputStream');
    while (!this.closed) {
      if (this.inboundQueue.length > 0) {
        yield this.inboundQueue.shift()!;
        continue;
      }
      const chunk = await new Promise<AudioChunk | null>((resolve) => {
        this.inboundResolvers.push(resolve);
      });
      if (chunk === null) return;
      yield chunk;
    }
  }

  async writeOutput(stream: AsyncIterable<AudioChunk>): Promise<void> {
    if (!this.opened || !this.outputProc) {
      throw new Error('[pulse-audio-bus] open() before writeOutput');
    }
    for await (const chunk of stream) {
      if (this.closed) return;
      this.outputProc.stdin.write(Buffer.from(chunk.payload));
    }
  }

  private handleInbound(buf: Buffer): void {
    if (!this.format) return;
    const chunk: AudioChunk = {
      format: this.format,
      payload: new Uint8Array(buf),
      ts_ms: Date.now(),
    };
    if (this.inboundResolvers.length > 0) {
      this.inboundResolvers.shift()!(chunk);
    } else {
      this.inboundQueue.push(chunk);
    }
  }

  private flushInboundDone(): void {
    while (this.inboundResolvers.length) {
      this.inboundResolvers.shift()!(null);
    }
  }
}

registerEnvironmentCapabilityProbe('audio-bus.pulseaudio', async () => {
  return new PulseAudioBus().probe();
});
