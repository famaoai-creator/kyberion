/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * ShellStreamingTextToSpeechBridge — pluggable subprocess adapter
 * mirroring the shell STT bridge.
 *
 * Contract:
 *   - stdin receives newline-delimited UTF-8 text segments.
 *   - stdout yields raw PCM_S16LE audio at the configured sample
 *     rate.
 *   - One stderr-end-of-utterance marker per emitted segment is
 *     optional; the bridge does not depend on it.
 *
 * Sample command (piper):
 *
 *   piper --model voice.onnx --output-raw  (with stdin fed text per line)
 *
 * Voice profile is forwarded via the `KYBERION_VOICE_PROFILE_ID` env
 * variable so the user's command can do the right routing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from './core.js';
import { buildSafeExecEnv } from './secure-io.js';
import { BoundedAudioQueue, DEFAULT_AUDIO_BUFFER_POLICY } from './bounded-audio-queue.js';
import {
  registerStreamingTtsBridge,
  type StreamingTextToSpeechBridge,
} from './streaming-tts-bridge.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';

export interface ShellStreamingTtsOptions {
  bridge_id: string;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  format?: AudioFormat;
  max_queued_chunks?: number;
  max_buffer_ms?: number;
}

const DEFAULT_FORMAT: AudioFormat = {
  encoding: 'pcm_s16le',
  sample_rate_hz: 16000,
  channels: 1,
};

export class ShellStreamingTextToSpeechBridge implements StreamingTextToSpeechBridge {
  readonly bridge_id: string;
  readonly format: AudioFormat;
  constructor(private readonly opts: ShellStreamingTtsOptions) {
    this.bridge_id = opts.bridge_id;
    this.format = opts.format ?? DEFAULT_FORMAT;
  }

  async *synthesizeStream(
    text: AsyncIterable<string>,
    voice_profile_id: string
  ): AsyncIterable<AudioChunk> {
    const command = validateTtsCommand(this.opts.command);
    const proc: ChildProcessWithoutNullStreams = spawn(command, [...(this.opts.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeExecEnv({
        ...(this.opts.env ?? {}),
        KYBERION_VOICE_PROFILE_ID: voice_profile_id,
      }),
    });
    let stderrTail = '';
    proc.stderr.on('data', (buf) => {
      stderrTail += buf.toString('utf8');
      if (stderrTail.length > 4_096) stderrTail = stderrTail.slice(-4_096);
    });

    const queue = new BoundedAudioQueue({
      ...DEFAULT_AUDIO_BUFFER_POLICY,
      ...(this.opts.max_queued_chunks ? { max_chunks: this.opts.max_queued_chunks } : {}),
      ...(this.opts.max_buffer_ms ? { max_buffer_ms: this.opts.max_buffer_ms } : {}),
    });
    let drained = false;

    proc.stdout.on('data', (buf: Buffer) => {
      const chunk: AudioChunk = {
        format: this.format,
        payload: new Uint8Array(buf),
        ts_ms: Date.now(),
      };
      queue.push(chunk);
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code !== 0) {
        logger.warn(
          `[shell-tts] command "${command}" exited code=${String(code)} signal=${String(signal)} stderr_tail=${stderrTail.slice(-256)}`
        );
      }
      drained = true;
      queue.close(code === 0 ? undefined : new Error(`shell TTS exited with code ${String(code)}`));
    };
    proc.on('exit', finish);
    proc.on('error', (error) => {
      drained = true;
      queue.close(error);
    });

    void (async () => {
      try {
        for await (const segment of text) {
          if (drained) break;
          if (!proc.stdin.write(segment + '\n')) await onceDrain(proc.stdin);
        }
      } finally {
        proc.stdin.end();
      }
    })();

    try {
      while (!drained) {
        const next = await queue.next();
        if (next === null) return;
        yield next;
      }
    } finally {
      if (!drained) terminateProcess(proc);
    }
  }
}

function validateTtsCommand(command: string): string {
  const normalized = String(command || '').trim();
  if (!normalized || /\s|\0/u.test(normalized))
    throw new Error('KYBERION_TTS_COMMAND must be a single executable path');
  return normalized;
}

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

function terminateProcess(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    /* already exited */
  }
  const timer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }, 500);
  timer.unref();
}

export function installShellStreamingTtsBridge(opts: ShellStreamingTtsOptions): void {
  registerStreamingTtsBridge(opts.bridge_id, () => new ShellStreamingTextToSpeechBridge(opts));
}

export function installShellStreamingTtsBridgeFromEnv(): { installed: boolean; reason?: string } {
  const command = process.env.KYBERION_TTS_COMMAND;
  if (!command) return { installed: false, reason: 'KYBERION_TTS_COMMAND not set' };
  const args = (process.env.KYBERION_TTS_ARGS ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  installShellStreamingTtsBridge({ bridge_id: 'shell', command, args });
  return { installed: true };
}
