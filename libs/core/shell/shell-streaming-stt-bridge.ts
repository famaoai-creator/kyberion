/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
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
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../core.js';
import { buildSafeExecEnv } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync } from '../secure-io.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { nowIso } from '../foundation/time.js';
import { resolveManagedToolPythonBin } from '../tool/tool-runtime-registry.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import {
  registerStreamingSttBridge,
  type StreamingSpeechToTextBridge,
  type StreamingSttCapabilities,
  type StreamingSttRequestOptions,
} from '../voice/streaming-stt-bridge.js';
import { primaryLanguageSubtag, WHISPER_LANGUAGES } from '../voice/speech-languages.js';
import type { AudioChunk, TranscriptChunk } from '../meeting/meeting-session-types.js';

export interface ShellStreamingSttOptions {
  bridge_id: string;
  command: string;
  args?: readonly string[];
  /** Optional env additions for the subprocess. */
  env?: Record<string, string>;
  /** Declared capabilities for seam selection; unset = not declared (may be cloud). */
  capabilities?: StreamingSttCapabilities;
}

/** Parse one untrusted NDJSON transcript emitted by the configured STT process. */
export function parseShellStreamingSttTranscript(line: string): TranscriptChunk | undefined {
  const parsed = parseSafeJsonObjectInput(line, 'shell STT transcript');
  if (!parsed) return undefined;
  return {
    utterance_id: String(parsed.utterance_id ?? `${Date.now()}`),
    is_final: Boolean(parsed.is_final ?? true),
    text: String(parsed.text ?? ''),
    ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
    ...(typeof parsed.speaker_label === 'string' ? { speaker_label: parsed.speaker_label } : {}),
    emitted_at: nowIso(),
  };
}

function validateShellCommand(command: string): string {
  const normalized = String(command || '').trim();
  if (!normalized) {
    throw new Error('KYBERION_STT_COMMAND must not be empty');
  }
  if (/\s/.test(normalized)) {
    throw new Error('KYBERION_STT_COMMAND must not contain whitespace');
  }
  if (/\0/.test(normalized)) {
    throw new Error('KYBERION_STT_COMMAND contains an invalid null byte');
  }
  return normalized;
}

export class ShellStreamingSpeechToTextBridge implements StreamingSpeechToTextBridge {
  readonly bridge_id: string;
  constructor(private readonly opts: ShellStreamingSttOptions) {
    this.bridge_id = opts.bridge_id;
  }

  async *transcribeStream(
    audio: AsyncIterable<AudioChunk>,
    options: StreamingSttRequestOptions = {}
  ): AsyncIterable<TranscriptChunk> {
    const command = validateShellCommand(this.opts.command);
    const language = primaryLanguageSubtag(options.language);
    const proc: ChildProcessWithoutNullStreams = spawn(command, [...(this.opts.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeExecEnv({
        ...this.opts.env,
        ...(language ? { KYBERION_STT_LANGUAGE: language } : {}),
      }),
    });
    let stderrTail = '';
    proc.stderr.on('data', (buf) => {
      stderrTail += buf.toString('utf8');
      if (stderrTail.length > 4_096) stderrTail = stderrTail.slice(-4_096);
    });

    const queue: TranscriptChunk[] = [];
    let notify: (() => void) | undefined;
    let stdoutBuffer = '';
    const decoder = new StringDecoder('utf8');
    let drained = false;
    let failure: Error | undefined;
    const wake = () => {
      notify?.();
      notify = undefined;
    };
    const fail = (error: unknown) => {
      failure ??= error instanceof Error ? error : new Error(String(error));
      drained = true;
      wake();
      terminateProcess(proc);
    };
    const enqueueLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const chunk = parseShellStreamingSttTranscript(line.trim());
        if (chunk) queue.push(chunk);
        wake();
      } catch (err: unknown) {
        logger.warn(
          `[shell-stt] non-JSON stdout: ${err instanceof Error ? err.message : String(err)}; line="${line.slice(0, 200)}"`
        );
      }
    };

    proc.stdout.on('data', (buf) => {
      stdoutBuffer += decoder.write(buf);
      let nl: number;
      while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        enqueueLine(line);
      }
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      stdoutBuffer += decoder.end();
      enqueueLine(stdoutBuffer);
      stdoutBuffer = '';
      if (code !== 0) {
        failure ??= new Error(
          `shell STT exited with code ${String(code)} signal=${String(signal)} stderr_tail=${stderrTail.slice(-256)}`
        );
      }
      drained = true;
      wake();
    };
    // close follows stdout EOF; exit alone can precede the last transcript bytes.
    proc.on('close', finish);
    proc.on('error', fail);
    proc.stdout.on('error', fail);
    proc.stdin.on('error', fail);

    // Pump audio into stdin in the background.
    void (async () => {
      try {
        for await (const chunk of audio) {
          if (drained) break;
          if (!proc.stdin.write(Buffer.from(chunk.payload))) await onceDrain(proc.stdin);
        }
      } finally {
        proc.stdin.end();
      }
    })().catch(fail);

    // Yield transcript chunks as they arrive.
    try {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (drained) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      drained = true;
      terminateProcess(proc);
    }
  }
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

export function installShellStreamingSttBridge(opts: ShellStreamingSttOptions): () => void {
  return registerStreamingSttBridge(
    opts.bridge_id,
    () => new ShellStreamingSpeechToTextBridge(opts),
    opts.capabilities
  );
}

/**
 * Convenience: installs from `KYBERION_STT_COMMAND` (and optional
 * `KYBERION_STT_ARGS`, comma-separated) under the bridge id `shell`.
 */
export function installShellStreamingSttBridgeFromEnv(env: NodeJS.ProcessEnv = process.env): {
  installed: boolean;
  reason?: string;
  dispose?: () => void;
} {
  const command = getRegisteredEnvText('KYBERION_STT_COMMAND', { env });
  if (!command) return { installed: false, reason: 'KYBERION_STT_COMMAND not set' };
  const args = (getRegisteredEnvText('KYBERION_STT_ARGS', { env }) ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const dispose = installShellStreamingSttBridge({ bridge_id: 'shell', command, args });
  return { installed: true, dispose };
}

/**
 * Install the resident MLX Whisper stream adapter when the managed runtime is
 * available and no explicit deployment-specific command was supplied.
 */
export function installManagedMlxWhisperStreamingSttBridgeIfAvailable(
  env: NodeJS.ProcessEnv = process.env
): { installed: boolean; reason?: string; bridge_id?: string; dispose?: () => void } {
  if (getRegisteredEnvText('KYBERION_STT_COMMAND', { env })?.trim()) {
    return { installed: false, reason: 'KYBERION_STT_COMMAND already configured' };
  }
  const command = resolveManagedToolPythonBin('mlx_whisper');
  const script = pathResolver.rootResolve('scripts/stt_mlx_whisper_stream.py');
  if (!command || !safeExistsSync(script)) {
    return { installed: false, reason: 'managed mlx_whisper stream runtime is unavailable' };
  }
  const bridgeId = 'managed_mlx_whisper';
  const dispose = installShellStreamingSttBridge({
    bridge_id: bridgeId,
    command,
    args: [script],
    capabilities: { local_only: true, languages: [...WHISPER_LANGUAGES] },
  });
  logger.success('[stt-bridge] installed managed mlx_whisper streaming bridge');
  return { installed: true, bridge_id: bridgeId, dispose };
}
