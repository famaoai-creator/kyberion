/**
 * BlackHole AudioBus (macOS).
 *
 * Strategy:
 *   1. Probe `system_profiler SPAudioDataType -json` for a BlackHole
 *      device. If absent, return `available=false` with installation
 *      hint; the coordinator falls back to a different bus.
 *   2. On `open`, spawn two long-lived `ffmpeg` subprocesses:
 *        - input:  ffmpeg -f avfoundation -i :":BlackHole 2ch"  →
 *          stdout streams PCM_S16LE that we hand to `inputStream`.
 *        - output: ffmpeg -f s16le -i pipe:0 -f avfoundation
 *          ":BlackHole 2ch"  →  consumes the chunks we get from
 *          `writeOutput`.
 *      ffmpeg already understands AVFoundation device names on macOS,
 *      so we don't need a Swift binding.
 *   3. The operator is responsible for routing Chrome's mic to
 *      "BlackHole 2ch" and the system output to a multi-output device
 *      that mirrors BlackHole — these are one-time System Settings
 *      gestures, not something the bus does at runtime.
 *
 * If `ffmpeg` is missing, `probe()` reports it cleanly. Tests can
 * substitute a `StubAudioBus`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from './core.js';
import { safeExec } from './secure-io.js';
import { registerEnvironmentCapabilityProbe } from './environment-capability.js';
import type {
  AudioBus,
  AudioBusProbe,
} from './audio-bus.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';

export interface BlackHoleBusOptions {
  /** AVFoundation device label; default matches a stock BlackHole 2ch install. */
  device_label?: string;
  /** Override the ffmpeg binary path (e.g., a homebrew location). */
  ffmpeg_bin?: string;
}

const DEFAULT_DEVICE_LABEL = 'BlackHole 2ch';

export class BlackHoleAudioBus implements AudioBus {
  readonly bus_id = 'blackhole' as const;
  private inputProc: ChildProcessWithoutNullStreams | null = null;
  private outputProc: ChildProcessWithoutNullStreams | null = null;
  private inboundQueue: AudioChunk[] = [];
  private inboundResolvers: Array<(chunk: AudioChunk | null) => void> = [];
  private opened = false;
  private closed = false;
  private format: AudioFormat | null = null;

  constructor(private readonly opts: BlackHoleBusOptions = {}) {}

  async probe(): Promise<AudioBusProbe> {
    if (process.platform !== 'darwin') {
      return {
        bus_id: 'blackhole',
        available: false,
        reason: `BlackHole bus requires macOS; current platform is ${process.platform}`,
      };
    }
    const label = this.opts.device_label ?? DEFAULT_DEVICE_LABEL;
    try {
      const ffmpeg = this.opts.ffmpeg_bin ?? 'ffmpeg';
      // -hide_banner -devices keeps ffmpeg from being chatty.
      const out = safeExec(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '""'], {
        env: process.env,
      });
      const devices = (out as string) || '';
      if (!devices.includes(label)) {
        return {
          bus_id: 'blackhole',
          available: false,
          reason: `device '${label}' not found in AVFoundation device list. Install BlackHole 2ch from https://existential.audio/blackhole/`,
        };
      }
      return {
        bus_id: 'blackhole',
        available: true,
        devices: { input: label, output: label },
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // ffmpeg writes the device list to stderr and exits non-zero by
      // design when given an empty `-i`; safeExec treats that as an
      // error. Inspect the captured stderr for the device label.
      if (typeof msg === 'string' && msg.includes(this.opts.device_label ?? DEFAULT_DEVICE_LABEL)) {
        return {
          bus_id: 'blackhole',
          available: true,
          devices: { input: this.opts.device_label ?? DEFAULT_DEVICE_LABEL, output: this.opts.device_label ?? DEFAULT_DEVICE_LABEL },
        };
      }
      return {
        bus_id: 'blackhole',
        available: false,
        reason: `ffmpeg probe failed: ${msg}`,
      };
    }
  }

  async open(format: AudioFormat): Promise<void> {
    if (this.opened) return;
    if (format.encoding !== 'pcm_s16le') {
      throw new Error(
        `[blackhole-audio-bus] only pcm_s16le is supported in this driver; got ${format.encoding}`,
      );
    }
    const probe = await this.probe();
    if (!probe.available) throw new Error(`[blackhole-audio-bus] not available: ${probe.reason}`);
    this.format = format;
    const ffmpeg = this.opts.ffmpeg_bin ?? 'ffmpeg';
    const label = this.opts.device_label ?? DEFAULT_DEVICE_LABEL;
    const channels = String(format.channels);
    const rate = String(format.sample_rate_hz);

    // Input: capture from BlackHole, emit s16le to stdout.
    this.inputProc = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'avfoundation',
        '-i', `:${label}`,
        '-ac', channels,
        '-ar', rate,
        '-f', 's16le',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.inputProc.stdout.on('data', (buf: Buffer) => this.handleInbound(buf));
    this.inputProc.stderr.on('data', (buf: Buffer) =>
      logger._log('debug', `[blackhole input] ${buf.toString('utf8').trim()}`),
    );
    this.inputProc.on('exit', (code) => {
      logger.info(`[blackhole-audio-bus] input ffmpeg exited with code ${code}`);
      this.flushInboundDone();
    });

    // Output: read s16le from stdin, push to BlackHole.
    this.outputProc = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ac', channels,
        '-ar', rate,
        '-i', 'pipe:0',
        '-f', 'avfoundation',
        `:${label}`,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    this.outputProc.stderr.on('data', (buf: Buffer) =>
      logger._log('debug', `[blackhole output] ${buf.toString('utf8').trim()}`),
    );
    this.outputProc.on('exit', (code) => {
      logger.info(`[blackhole-audio-bus] output ffmpeg exited with code ${code}`);
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
    this.flushInboundDone();
  }

  async *inputStream(): AsyncIterable<AudioChunk> {
    if (!this.opened) throw new Error('[blackhole-audio-bus] open() before reading inputStream');
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
      throw new Error('[blackhole-audio-bus] open() before writeOutput');
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

// Register the audio-bus probe for environment-capability manifests
// (`probe.kind: 'probe'` with `probe_id: 'audio-bus.blackhole'`).
registerEnvironmentCapabilityProbe('audio-bus.blackhole', async () => {
  return new BlackHoleAudioBus().probe();
});
