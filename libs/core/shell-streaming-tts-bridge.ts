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
    voice_profile_id: string,
  ): AsyncIterable<AudioChunk> {
    const proc: ChildProcessWithoutNullStreams = spawn(
      this.opts.command,
      [...(this.opts.args ?? [])],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(this.opts.env ?? {}),
          KYBERION_VOICE_PROFILE_ID: voice_profile_id,
        },
      },
    );
    let stderrTail = '';
    proc.stderr.on('data', (buf) => {
      stderrTail += buf.toString('utf8');
      if (stderrTail.length > 4_096) stderrTail = stderrTail.slice(-4_096);
    });

    const queue: AudioChunk[] = [];
    const resolvers: Array<(c: AudioChunk | null) => void> = [];
    let drained = false;

    proc.stdout.on('data', (buf: Buffer) => {
      const chunk: AudioChunk = {
        format: this.format,
        payload: new Uint8Array(buf),
        ts_ms: Date.now(),
      };
      if (resolvers.length) resolvers.shift()!(chunk);
      else queue.push(chunk);
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`[shell-tts] command "${this.opts.command}" exited code=${code} stderr_tail=${stderrTail.slice(-256)}`);
      }
      drained = true;
      while (resolvers.length) resolvers.shift()!(null);
    });

    void (async () => {
      try {
        for await (const segment of text) {
          if (drained) break;
          proc.stdin.write(segment + '\n');
        }
      } finally {
        proc.stdin.end();
      }
    })();

    while (!drained) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      const next = await new Promise<AudioChunk | null>((resolve) => {
        resolvers.push(resolve);
      });
      if (next === null) return;
      yield next;
    }
  }
}

export function installShellStreamingTtsBridge(opts: ShellStreamingTtsOptions): void {
  registerStreamingTtsBridge(opts.bridge_id, () => new ShellStreamingTextToSpeechBridge(opts));
}

export function installShellStreamingTtsBridgeFromEnv(): { installed: boolean; reason?: string } {
  const command = process.env.KYBERION_TTS_COMMAND;
  if (!command) return { installed: false, reason: 'KYBERION_TTS_COMMAND not set' };
  const args = (process.env.KYBERION_TTS_ARGS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  installShellStreamingTtsBridge({ bridge_id: 'shell', command, args });
  return { installed: true };
}
