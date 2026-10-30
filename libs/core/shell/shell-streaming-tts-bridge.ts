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

import { getRegisteredEnvText } from '../foundation/env.js';

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../core.js';
import { buildSafeExecEnv } from '../secure-io.js';
import { BoundedAudioQueue, DEFAULT_AUDIO_BUFFER_POLICY } from '../bounded-audio-queue.js';
import {
  registerStreamingTtsBridge,
  type StreamingTextToSpeechBridge,
  type StreamingTtsCapabilities,
} from '../voice/streaming-tts-bridge.js';
import type { AudioChunk, AudioFormat } from '../meeting/meeting-session-types.js';

export interface ShellStreamingTtsOptions {
  bridge_id: string;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  format?: AudioFormat;
  max_queued_chunks?: number;
  max_buffer_ms?: number;
  /**
   * Keep the child process alive across synthesizeStream calls and demux
   * per-request audio with a length-prefixed frame protocol:
   * `uint32be length` + PCM payload, and a zero-length frame after every
   * input line marks end-of-request. Requires the command to speak that
   * protocol (e.g. qwen3_tts_stream_bridge.py --stream-framed). Use for
   * engines whose model load dominates per-call cost (cloned voices).
   */
  persistent?: boolean;
  /**
   * What the operator's command can do. Default: languages ['*'] (the command
   * decides) and not local_only (it may be a cloud CLI).
   */
  capabilities?: StreamingTtsCapabilities;
}

const DEFAULT_SHELL_CAPABILITIES: StreamingTtsCapabilities = {
  languages: ['*'],
  local_only: false,
};

const DEFAULT_FORMAT: AudioFormat = {
  encoding: 'pcm_s16le',
  sample_rate_hz: 16000,
  channels: 1,
};

export class ShellStreamingTextToSpeechBridge implements StreamingTextToSpeechBridge {
  readonly bridge_id: string;
  readonly format: AudioFormat;
  readonly capabilities: StreamingTtsCapabilities;
  private channel: PersistentFramedTtsChannel | null = null;
  private disposed = false;
  private readonly ephemeralProcesses = new Set<ChildProcessWithoutNullStreams>();
  constructor(private readonly opts: ShellStreamingTtsOptions) {
    this.bridge_id = opts.bridge_id;
    this.format = opts.format ?? DEFAULT_FORMAT;
    this.capabilities = opts.capabilities ?? DEFAULT_SHELL_CAPABILITIES;
  }

  async *synthesizeStream(
    text: AsyncIterable<string>,
    voice_profile_id: string
  ): AsyncIterable<AudioChunk> {
    if (this.disposed) throw new Error('TTS bridge is disposed');
    if (this.opts.persistent) {
      this.channel ??= new PersistentFramedTtsChannel(this.opts, this.format);
      yield* this.channel.request(text, voice_profile_id);
      return;
    }
    yield* this.synthesizeStreamEphemeral(text, voice_profile_id);
  }

  /** Terminate the resident worker (persistent mode). Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.channel?.dispose();
    this.channel = null;
    for (const proc of this.ephemeralProcesses) terminateProcess(proc);
    this.ephemeralProcesses.clear();
  }

  private async *synthesizeStreamEphemeral(
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
    this.ephemeralProcesses.add(proc);
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
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      failure ??= error;
      drained = true;
      queue.close(failure);
      terminateProcess(proc);
    };

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
      if (code !== 0) failure ??= new Error(`shell TTS exited with code ${String(code)}`);
      queue.close(failure);
    };
    // close follows exit and the closure of stdout: trailing PCM is queued first.
    proc.on('close', finish);
    proc.on('error', fail);
    proc.stdin.on('error', fail);
    proc.stdout.on('error', fail);

    void (async () => {
      try {
        for await (const segment of text) {
          if (drained) break;
          if (!proc.stdin.write(segment + '\n')) await onceDrain(proc.stdin);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        proc.stdin.end();
      }
    })();

    try {
      for (;;) {
        const next = await queue.next();
        if (next === null) {
          // BoundedAudioQueue resolves an already-pending waiter on close(error).
          if (failure) throw failure;
          return;
        }
        yield next;
      }
    } finally {
      drained = true;
      this.ephemeralProcesses.delete(proc);
      terminateProcess(proc);
    }
  }
}

/** Hard bound on one frame; anything larger is a protocol bug, not audio. */
const MAX_FRAME_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** Mirrors MAX_SEGMENT_CHARS in qwen3_tts_stream_bridge.py — oversized lines
 *  make the worker exit, which would fail every queued request. */
const MAX_STREAM_SEGMENT_CHARS = 800;

interface PendingTtsRequest {
  queue: BoundedAudioQueue;
  textIter: AsyncIterator<string>;
  profileId: string;
  /** Lines written to the worker whose end-of-request frame has not arrived. */
  outstandingLines: number;
  /** The caller's text iterable ran dry — no more lines will be written. */
  inputDone: boolean;
  aborted: boolean;
  /** Set when the request closed with an error — rethrown to the consumer. */
  error?: Error;
}

/**
 * Keeps one framed-protocol worker alive for the bridge's lifetime and
 * demultiplexes per-request audio. Requests are served strictly FIFO because
 * the wire has no request ids: each input line yields payload frames then one
 * zero-length end-of-request frame.
 *
 * Aborted requests drain in the background — the worker finishes their queued
 * lines while the consumer has already moved on. That wastes a little worker
 * time but avoids a model reload; a kill-and-respawn path is the escape hatch
 * if a worker wedges or desyncs.
 */
class PersistentFramedTtsChannel {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private procProfileId = '';
  private stderrTail = '';
  private stdoutChunks: Buffer[] = [];
  private readonly pending: PendingTtsRequest[] = [];
  private active: PendingTtsRequest | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private cleanupRegistered = false;
  private disposed = false;
  /** No frame for this long while lines are outstanding ⇒ worker is wedged. */
  private readonly stallTimeoutMs = 120_000;

  constructor(
    private readonly opts: ShellStreamingTtsOptions,
    private readonly format: AudioFormat
  ) {}

  async *request(
    text: AsyncIterable<string>,
    voice_profile_id: string
  ): AsyncGenerator<AudioChunk> {
    const req: PendingTtsRequest = {
      queue: new BoundedAudioQueue({
        ...DEFAULT_AUDIO_BUFFER_POLICY,
        ...(this.opts.max_queued_chunks ? { max_chunks: this.opts.max_queued_chunks } : {}),
        ...(this.opts.max_buffer_ms ? { max_buffer_ms: this.opts.max_buffer_ms } : {}),
      }),
      textIter: text[Symbol.asyncIterator](),
      profileId: voice_profile_id,
      outstandingLines: 0,
      inputDone: false,
      aborted: false,
    };
    if (this.disposed) {
      req.error = new Error('persistent TTS channel is disposed');
      req.queue.close(req.error);
      throw req.error;
    }
    this.ensureProcess(voice_profile_id);
    this.pending.push(req);
    this.advance();
    try {
      for (;;) {
        const next = await req.queue.next();
        if (next === null) {
          // Waiters resolve null on close(error) — surface the failure.
          if (req.error) throw req.error;
          return;
        }
        yield next;
      }
    } finally {
      req.aborted = true;
      void req.textIter.return?.(undefined).catch(() => undefined);
      req.inputDone = true;
      this.maybeFinishActive();
    }
  }

  private ensureProcess(voiceProfileId: string): void {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return;
    const command = validateTtsCommand(this.opts.command);
    const proc = spawn(command, [...(this.opts.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeExecEnv({
        ...(this.opts.env ?? {}),
        KYBERION_VOICE_PROFILE_ID: voiceProfileId,
      }),
    });
    this.proc = proc;
    this.procProfileId = voiceProfileId;
    this.stderrTail = '';
    this.stdoutChunks = [];
    proc.stderr.on('data', (buf: Buffer) => {
      if (this.proc !== proc) return;
      this.stderrTail += buf.toString('utf8');
      if (this.stderrTail.length > 4_096) this.stderrTail = this.stderrTail.slice(-4_096);
    });
    // Guard on generation: a dying previous worker's flushed bytes must never
    // demux into the new worker's requests.
    proc.stdout.on('data', (buf: Buffer) => {
      if (this.proc === proc) this.onStdoutData(buf);
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.failAll(
        new Error(
          `persistent TTS worker exited code=${String(code)} signal=${String(signal)}` +
            (this.stderrTail.trim() ? ` stderr_tail=${this.stderrTail.slice(-256)}` : '')
        )
      );
    };
    proc.on('exit', finish);
    proc.on('error', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.failAll(new Error('persistent TTS worker spawn failed'));
    });
    proc.stdin.on('error', () => {
      /* EPIPE races with an exiting worker; finish() reports it. */
    });
    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true;
      const kill = (): void => {
        if (this.proc) terminateProcess(this.proc);
      };
      process.once('exit', kill);
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          kill();
          process.kill(process.pid, signal);
        });
      }
    }
  }

  private onStdoutData(buf: Buffer): void {
    this.stdoutChunks.push(buf);
    this.bumpStallTimer();
    const bufAll = Buffer.concat(this.stdoutChunks);
    let offset = 0;
    for (;;) {
      if (bufAll.length - offset < 4) break;
      const length = bufAll.readUInt32BE(offset);
      if (length > MAX_FRAME_PAYLOAD_BYTES) {
        this.failAll(new Error(`persistent TTS worker emitted oversized frame (${length}B)`));
        this.killWorker();
        this.stdoutChunks = [];
        return;
      }
      if (bufAll.length - offset < 4 + length) break;
      // Any frame — payload or EOR — requires an outstanding written line:
      // the worker only emits for input it received. Anything else means the
      // wire is desynced and no request boundary can be trusted anymore.
      if (!this.active || this.active.outstandingLines === 0) {
        this.failAll(new Error('persistent TTS worker desynced: unexpected frame'));
        this.killWorker();
        this.stdoutChunks = [];
        return;
      }
      if (length === 0) {
        // End-of-request marker: the worker finished one input line.
        this.active.outstandingLines -= 1;
        this.maybeFinishActive();
      } else if (!this.active.aborted) {
        // An aborted-but-active request still drains its own frames
        // (discarded) — FIFO keeps its bytes ahead of the next call's.
        const payload = bufAll.subarray(offset + 4, offset + 4 + length);
        this.active.queue.push({
          format: this.format,
          payload: new Uint8Array(payload),
          ts_ms: Date.now(),
        });
      }
      offset += 4 + length;
    }
    this.stdoutChunks = offset >= bufAll.length ? [] : [bufAll.subarray(offset)];
  }

  private advance(): void {
    if (this.active || this.pending.length === 0 || this.disposed) return;
    const req = this.pending.shift() as PendingTtsRequest;
    if (req.aborted) {
      // Cancelled while queued — skip it without touching the worker.
      this.clearActive(req);
      return;
    }
    // A different voice profile needs a fresh worker — the reference voice is
    // baked into the process env at spawn.
    if (
      this.proc &&
      this.proc.exitCode === null &&
      !this.proc.killed &&
      this.procProfileId !== req.profileId
    ) {
      this.killWorker();
    }
    try {
      this.ensureProcess(req.profileId);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.active = req;
    void this.writeRequest(req);
  }

  private async writeRequest(req: PendingTtsRequest): Promise<void> {
    try {
      for (;;) {
        if (req.aborted || this.active !== req) break;
        const next = await req.textIter.next();
        if (next.done) break;
        if (req.aborted || this.active !== req) break;
        // The wire protocol is line-based — a segment must not smuggle extra
        // physical lines or the worker would emit unaccounted EOR frames.
        const line = String(next.value ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        if (line.length > MAX_STREAM_SEGMENT_CHARS) {
          // The worker hard-exits on oversized lines, which would poison every
          // queued request — fail just this one and keep the wire clean.
          req.error = new Error(
            `TTS segment exceeds the ${MAX_STREAM_SEGMENT_CHARS}-character limit`
          );
          req.queue.close(req.error);
          req.aborted = true;
          break;
        }
        const proc = this.proc;
        if (!proc || proc.exitCode !== null || proc.killed) {
          throw new Error('persistent TTS worker is not running');
        }
        req.outstandingLines += 1;
        this.bumpStallTimer();
        if (!proc.stdin.write(line + '\n')) await onceDrain(proc.stdin);
        if (req.aborted || this.active !== req || this.proc !== proc) break;
      }
    } catch (error) {
      if (!req.aborted) {
        req.error = error instanceof Error ? error : new Error(String(error));
        req.queue.close(req.error);
      }
      this.clearActive(req);
      return;
    } finally {
      req.inputDone = true;
    }
    this.maybeFinishActive();
  }

  private maybeFinishActive(): void {
    const req = this.active;
    if (!req || !req.inputDone || req.outstandingLines > 0) return;
    req.queue.close();
    this.clearActive(req);
  }

  private bumpStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    const req = this.active;
    if (!req || req.outstandingLines === 0) return;
    this.stallTimer = setTimeout(() => {
      // The request this was armed for may have already completed — only fail
      // if it is still active and still owed frames.
      if (this.active !== req || req.outstandingLines === 0) return;
      this.failAll(
        new Error(`persistent TTS worker stalled (no frames for ${this.stallTimeoutMs}ms)`)
      );
      this.killWorker();
    }, this.stallTimeoutMs);
    this.stallTimer.unref();
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private killWorker(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) terminateProcess(proc);
  }

  dispose(): void {
    this.disposed = true;
    this.clearStallTimer();
    this.killWorker();
    this.failAll(new Error('persistent TTS channel disposed'));
  }

  private clearActive(req: PendingTtsRequest): void {
    if (this.active === req) {
      this.active = null;
      this.clearStallTimer();
      this.advance();
    } else {
      const index = this.pending.indexOf(req);
      if (index >= 0) this.pending.splice(index, 1);
    }
  }

  private failAll(error: Error): void {
    this.clearStallTimer();
    if (this.active) {
      this.active.error = error;
      this.active.queue.close(error);
      this.active = null;
    }
    for (const req of this.pending.splice(0)) {
      req.error = error;
      req.queue.close(error);
    }
    this.stdoutChunks = [];
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
    const onDrain = (): void => {
      stream.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      stream.off('drain', onDrain);
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
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

export function installShellStreamingTtsBridge(opts: ShellStreamingTtsOptions): () => void {
  return registerStreamingTtsBridge(
    opts.bridge_id,
    () => new ShellStreamingTextToSpeechBridge(opts)
  );
}

export function installShellStreamingTtsBridgeFromEnv(sourceEnv: NodeJS.ProcessEnv = process.env): {
  installed: boolean;
  reason?: string;
  dispose?: () => void;
} {
  const command = getRegisteredEnvText('KYBERION_TTS_COMMAND', { env: sourceEnv });
  if (!command) return { installed: false, reason: 'KYBERION_TTS_COMMAND not set' };
  const args = (getRegisteredEnvText('KYBERION_TTS_ARGS', { env: sourceEnv }) ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  // Most streaming engines emit their model's native rate (kokoro: 24000).
  // Declaring the real rate keeps the ffplay sink from mis-pitching it —
  // chunks carry this format through. Non-governed rates (e.g. piper 22050)
  // must be resampled inside the TTS command wrapper instead.
  const rateRaw = getRegisteredEnvText('KYBERION_TTS_SAMPLE_RATE_HZ', { env: sourceEnv })?.trim();
  const parsedRate = rateRaw ? Number.parseInt(rateRaw, 10) : NaN;
  const format = [16000, 24000, 48000].includes(parsedRate)
    ? { ...DEFAULT_FORMAT, sample_rate_hz: parsedRate as AudioFormat['sample_rate_hz'] }
    : DEFAULT_FORMAT;
  // Persistent mode expects the command to emit length-prefixed frames —
  // qwen3_tts_stream_bridge.py --stream-framed — so one worker serves every
  // turn without a per-call model reload.
  const persistent = ['1', 'true', 'yes', 'on'].includes(
    (getRegisteredEnvText('KYBERION_TTS_PERSISTENT', { env: sourceEnv }) ?? '').trim().toLowerCase()
  );
  // Wrapper-tunable envs: the child process runs under a sanitised env, so
  // overrides must be forwarded explicitly through the spawn options.
  const env: Record<string, string> = {};
  for (const name of [
    'KYBERION_QWEN3_PYTHON',
    'KYBERION_QWEN3_MODEL_ID',
    'KYBERION_QWEN3_REF_AUDIO',
    'KYBERION_QWEN3_REF_TEXT',
    'KYBERION_QWEN3_MEMORY_LIMIT_GB',
    'KYBERION_PIPER_BIN',
    'KYBERION_PIPER_MODEL',
    'KYBERION_PIPER_RATE',
    'KYBERION_PIPER_OUT_RATE',
  ]) {
    const value = getRegisteredEnvText(name, { env: sourceEnv });
    if (value) env[name] = value;
  }
  const dispose = installShellStreamingTtsBridge({
    bridge_id: 'shell',
    command,
    args,
    format,
    persistent,
    ...(Object.keys(env).length ? { env } : {}),
  });
  return { installed: true, dispose };
}
