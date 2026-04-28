/**
 * ShellStreamingSpeechToTextBridge — pluggable subprocess adapter.
 *
 * The user supplies a command (env: `KYBERION_STT_COMMAND`) that takes
 * raw PCM_S16LE on stdin and emits NDJSON transcript chunks on stdout:
 *
 *   {"utterance_id":"u1","is_final":true,"text":"...","confidence":0.92}
 *
 * Sample command (whisper.cpp streaming wrapper):
 *
 *   whisper-stream --model ggml-base.bin --language ja --json
 *
 * A deployment can swap in deepgram CLI / faster-whisper / vosk by
 * pointing the env var elsewhere — the bridge only cares about the
 * NDJSON contract.
 *
 * If the command is not configured, this module exports the
 * registration helper but the registry stays at the stub default.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from './core.js';
import {
  registerStreamingSttBridge,
  type StreamingSpeechToTextBridge,
} from './streaming-stt-bridge.js';
import type { AudioChunk, TranscriptChunk } from './meeting-session-types.js';

export interface ShellStreamingSttOptions {
  bridge_id: string;
  command: string;
  args?: readonly string[];
  /** Optional env additions for the subprocess. */
  env?: Record<string, string>;
}

export class ShellStreamingSpeechToTextBridge implements StreamingSpeechToTextBridge {
  readonly bridge_id: string;
  constructor(private readonly opts: ShellStreamingSttOptions) {
    this.bridge_id = opts.bridge_id;
  }

  async *transcribeStream(audio: AsyncIterable<AudioChunk>): AsyncIterable<TranscriptChunk> {
    const proc: ChildProcessWithoutNullStreams = spawn(
      this.opts.command,
      [...(this.opts.args ?? [])],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.opts.env ?? {}) },
      },
    );
    let stderrTail = '';
    proc.stderr.on('data', (buf) => {
      stderrTail += buf.toString('utf8');
      if (stderrTail.length > 4_096) stderrTail = stderrTail.slice(-4_096);
    });

    const queue: TranscriptChunk[] = [];
    const resolvers: Array<(c: TranscriptChunk | null) => void> = [];
    let stdoutBuffer = '';
    let drained = false;

    proc.stdout.on('data', (buf) => {
      stdoutBuffer += buf.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          const chunk: TranscriptChunk = {
            utterance_id: String(parsed.utterance_id ?? `${Date.now()}`),
            is_final: Boolean(parsed.is_final ?? true),
            text: String(parsed.text ?? ''),
            ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
            ...(typeof parsed.speaker_label === 'string'
              ? { speaker_label: parsed.speaker_label }
              : {}),
            emitted_at: new Date().toISOString(),
          };
          if (resolvers.length) resolvers.shift()!(chunk);
          else queue.push(chunk);
        } catch (err: any) {
          logger.warn(`[shell-stt] non-JSON stdout: ${err?.message ?? err}; line="${line.slice(0, 200)}"`);
        }
      }
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`[shell-stt] command "${this.opts.command}" exited code=${code} stderr_tail=${stderrTail.slice(-256)}`);
      }
      drained = true;
      while (resolvers.length) resolvers.shift()!(null);
    });

    // Pump audio into stdin in the background.
    void (async () => {
      try {
        for await (const chunk of audio) {
          if (drained) break;
          proc.stdin.write(Buffer.from(chunk.payload));
        }
      } finally {
        proc.stdin.end();
      }
    })();

    // Yield transcript chunks as they arrive.
    while (!drained) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      const next = await new Promise<TranscriptChunk | null>((resolve) => {
        resolvers.push(resolve);
      });
      if (next === null) return;
      yield next;
    }
  }
}

export function installShellStreamingSttBridge(opts: ShellStreamingSttOptions): void {
  registerStreamingSttBridge(opts.bridge_id, () => new ShellStreamingSpeechToTextBridge(opts));
}

/**
 * Convenience: installs from `KYBERION_STT_COMMAND` (and optional
 * `KYBERION_STT_ARGS`, comma-separated) under the bridge id `shell`.
 */
export function installShellStreamingSttBridgeFromEnv(): { installed: boolean; reason?: string } {
  const command = process.env.KYBERION_STT_COMMAND;
  if (!command) return { installed: false, reason: 'KYBERION_STT_COMMAND not set' };
  const args = (process.env.KYBERION_STT_ARGS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  installShellStreamingSttBridge({ bridge_id: 'shell', command, args });
  return { installed: true };
}
