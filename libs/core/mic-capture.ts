/* eslint-disable no-restricted-imports */
/**
 * Standalone microphone capture — the entry point for "record the room"
 * flows (in-room minutes, in-room meeting attendance). Unlike the meeting
 * audio buses (BlackHole/Pulse loopback of *meeting* audio), this captures
 * the physical microphone directly via ffmpeg (macOS avfoundation) or
 * arecord (Linux), emitting PCM_S16LE mono chunks compatible with
 * `AudioChunk` consumers (EnergyVad, STT bridges).
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AudioChunk } from './meeting-session-types.js';

export interface MicCaptureOptions {
  /** Input device: avfoundation index (":0") on darwin, ALSA device on linux. */
  device?: string;
  sampleRateHz?: 16000 | 24000 | 48000;
  /** Milliseconds of audio per emitted chunk. */
  chunkMs?: number;
  /**
   * Full command override (argv array). When provided, it is spawned as-is
   * and must write PCM_S16LE mono at sampleRateHz to stdout. Used by tests
   * to replay fixture audio deterministically.
   */
  command?: string[];
}

export interface MicCaptureSession {
  chunks(): AsyncIterable<AudioChunk>;
  stop(): Promise<void>;
}

export interface MicCaptureProbeResult {
  available: boolean;
  backend: 'ffmpeg-avfoundation' | 'arecord' | 'custom' | 'none';
  reason?: string;
}

function defaultCommand(opts: Required<Pick<MicCaptureOptions, 'device' | 'sampleRateHz'>>): {
  argv: string[];
  backend: MicCaptureProbeResult['backend'];
} {
  if (process.platform === 'darwin') {
    return {
      backend: 'ffmpeg-avfoundation',
      argv: [
        'ffmpeg',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'avfoundation',
        '-i',
        opts.device,
        '-ac',
        '1',
        '-ar',
        String(opts.sampleRateHz),
        '-f',
        's16le',
        '-',
      ],
    };
  }
  return {
    backend: 'arecord',
    argv: [
      'arecord',
      ...(opts.device && opts.device !== ':0' ? ['-D', opts.device] : []),
      '-f',
      'S16_LE',
      '-r',
      String(opts.sampleRateHz),
      '-c',
      '1',
      '-t',
      'raw',
    ],
  };
}

export function probeMicCapture(opts: MicCaptureOptions = {}): MicCaptureProbeResult {
  if (opts.command?.length) return { available: true, backend: 'custom' };
  const binary = process.platform === 'darwin' ? 'ffmpeg' : 'arecord';
  const probe = spawnSync(binary, ['-version'], { stdio: 'ignore' });
  if (probe.error || probe.status === null) {
    return {
      available: false,
      backend: 'none',
      reason: `${binary} is not available on PATH — install it to enable microphone capture`,
    };
  }
  return {
    available: true,
    backend: process.platform === 'darwin' ? 'ffmpeg-avfoundation' : 'arecord',
  };
}

export async function startMicCapture(opts: MicCaptureOptions = {}): Promise<MicCaptureSession> {
  const sampleRateHz = opts.sampleRateHz ?? 16_000;
  const chunkMs = opts.chunkMs ?? 100;
  const bytesPerChunk = Math.max(2, Math.floor((sampleRateHz * 2 * chunkMs) / 1000));

  const argv =
    opts.command && opts.command.length > 0
      ? opts.command
      : defaultCommand({ device: opts.device ?? ':0', sampleRateHz }).argv;

  const child: ChildProcessWithoutNullStreams = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stderr.on('data', (data: Buffer) => {
    stderrTail = `${stderrTail}${data.toString()}`.slice(-2000);
  });

  const startedAt = Date.now();
  let stopped = false;
  let pending = Buffer.alloc(0);
  const queue: AudioChunk[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let spawnError: Error | null = null;

  const wake = () => {
    notify?.();
    notify = null;
  };

  child.on('error', (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
    ended = true;
    wake();
  });
  child.stdout.on('data', (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= bytesPerChunk) {
      const payload = pending.subarray(0, bytesPerChunk);
      pending = pending.subarray(bytesPerChunk);
      queue.push({
        format: { encoding: 'pcm_s16le', sample_rate_hz: sampleRateHz, channels: 1 },
        payload: new Uint8Array(payload),
        ts_ms: Date.now() - startedAt,
      });
    }
    wake();
  });
  child.on('close', () => {
    if (pending.length > 0) {
      queue.push({
        format: { encoding: 'pcm_s16le', sample_rate_hz: sampleRateHz, channels: 1 },
        payload: new Uint8Array(pending),
        ts_ms: Date.now() - startedAt,
      });
      pending = Buffer.alloc(0);
    }
    ended = true;
    wake();
  });

  async function* iterate(): AsyncIterable<AudioChunk> {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as AudioChunk;
        continue;
      }
      if (spawnError && !stopped) {
        throw new Error(
          `[mic-capture] ${argv[0]} failed: ${spawnError.message}${stderrTail ? ` — ${stderrTail.trim()}` : ''}`
        );
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  return {
    chunks: iterate,
    stop: async () => {
      stopped = true;
      if (!ended) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 1500);
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}
