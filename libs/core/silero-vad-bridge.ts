/* eslint-disable no-restricted-imports */
/**
 * Silero VAD bridge — neural voice activity detection over a Python
 * subprocess (onnxruntime), satisfying the `VoiceActivityDetector`
 * interface so it can replace EnergyVad in noisy environments.
 *
 * Protocol (NDJSON over stdio, one JSON object per line):
 *   → {"pcm": "<base64 s16le mono>", "sr": 16000}
 *   ← {"prob": 0.87}
 *   → {"reset": true}
 *   ← {"ok": true}
 *   ← {"error": "..."}            (fatal; bridge degrades to energy)
 *
 * `ingest()` must stay synchronous per the interface, so the bridge is
 * one chunk "late" by design: each call ships the chunk to the
 * subprocess and decides with the most recent probability received.
 * On any subprocess failure it degrades to an internal EnergyVad and
 * remembers the reason — callers can inspect `degradedReason`.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildSafeExecEnv } from './secure-io.js';
import { rootResolve } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { resolveManagedToolPythonBin } from './tool-runtime-registry.js';
import { registerVadBackend, type VadFactoryOptions } from './vad-registry.js';
import {
  computeChunkDurationMs,
  EnergyVad,
  type VoiceActivityDetector,
  type VoiceActivityState,
} from './voice-activity-detector.js';
import type { AudioChunk } from './meeting-session-types.js';

export interface SileroVadOptions {
  /** Python interpreter (default: KYBERION_SILERO_VAD_PYTHON → KYBERION_PYTHON_BIN → python3). */
  pythonBin?: string;
  /** Bridge script (default: libs/actuators/voice-actuator/scripts/silero_vad_bridge.py). */
  scriptPath?: string;
  /** Path to the silero_vad ONNX model (default: KYBERION_SILERO_VAD_MODEL). */
  modelPath?: string;
  /** Speech probability threshold (default 0.5). */
  probThreshold?: number;
  /** ms of continuous silence before declaring an endpoint. */
  endpointMs?: number;
  /** Fallback EnergyVad threshold used if the subprocess dies. */
  fallbackRmsThreshold?: number;
  /** Full command override for tests (spawned as-is, speaks the NDJSON protocol). */
  command?: string[];
}

export function defaultSileroVadScriptPath(): string {
  return rootResolve('libs/actuators/voice-actuator/scripts/silero_vad_bridge.py');
}

function resolvePythonBin(opts: SileroVadOptions): string {
  return (
    opts.pythonBin ||
    process.env.KYBERION_SILERO_VAD_PYTHON ||
    process.env.KYBERION_PYTHON_BIN ||
    resolveManagedToolPythonBin('silero_vad') ||
    'python3'
  );
}

function resolveModelPath(opts: SileroVadOptions): string | undefined {
  return opts.modelPath || process.env.KYBERION_SILERO_VAD_MODEL || undefined;
}

export function probeSileroVad(opts: SileroVadOptions = {}): {
  available: boolean;
  reason?: string;
} {
  if (opts.command?.length) return { available: true };
  const scriptPath = opts.scriptPath || defaultSileroVadScriptPath();
  if (!safeExistsSync(scriptPath)) {
    return { available: false, reason: `silero bridge script missing at ${scriptPath}` };
  }
  const modelPath = resolveModelPath(opts);
  if (!modelPath) {
    return {
      available: false,
      reason: 'KYBERION_SILERO_VAD_MODEL is not set (path to silero_vad .onnx)',
    };
  }
  if (!safeExistsSync(modelPath)) {
    return { available: false, reason: `silero model not found at ${modelPath}` };
  }
  const dependencyProbe = spawnSync(resolvePythonBin(opts), ['-c', 'import numpy, onnxruntime'], {
    stdio: 'ignore',
    env: buildSafeExecEnv(),
    timeout: 5000,
  });
  if (dependencyProbe.error || dependencyProbe.status !== 0) {
    return {
      available: false,
      reason: `Silero Python dependencies unavailable: ${dependencyProbe.error?.message || `exit ${dependencyProbe.status}`}`,
    };
  }
  return { available: true };
}

export class SileroVad implements VoiceActivityDetector {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lastProb = 0;
  private failedReason: string | null = null;
  private readonly fallback: EnergyVad;
  private readonly probThreshold: number;
  private readonly endpointMs: number;

  private silenceMs = 0;
  private hadSpeechSinceEndpoint = false;
  private endpointFired = false;

  constructor(private readonly opts: SileroVadOptions = {}) {
    this.probThreshold = opts.probThreshold ?? 0.5;
    this.endpointMs = opts.endpointMs ?? 700;
    this.fallback = new EnergyVad({
      rms_threshold: opts.fallbackRmsThreshold ?? 800,
      endpoint_ms: this.endpointMs,
    });
    this.start();
  }

  /** Non-null once the subprocess has failed and energy fallback is active. */
  get degradedReason(): string | null {
    return this.failedReason;
  }

  private start(): void {
    const argv = this.opts.command?.length
      ? this.opts.command
      : [
          resolvePythonBin(this.opts),
          this.opts.scriptPath || defaultSileroVadScriptPath(),
          '--model',
          resolveModelPath(this.opts) || '',
        ];
    try {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeExecEnv(),
      });
      let stdoutBuffer = '';
      child.stdout.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString('utf8');
        let nl: number;
        while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, nl).trim();
          stdoutBuffer = stdoutBuffer.slice(nl + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as { prob?: number; error?: string };
            if (typeof parsed.prob === 'number') this.lastProb = parsed.prob;
            else if (parsed.error) this.fail(`bridge error: ${parsed.error}`);
          } catch {
            /* ignore non-JSON noise */
          }
        }
      });
      let stderrTail = '';
      child.stderr.on('data', (data: Buffer) => {
        stderrTail = `${stderrTail}${data.toString()}`.slice(-1000);
      });
      child.on('error', (error) => this.fail(error.message));
      child.on('close', (code) => {
        if (!this.failedReason) {
          this.fail(
            `silero bridge exited code=${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}`
          );
        }
      });
      this.child = child;
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private fail(reason: string): void {
    if (!this.failedReason) this.failedReason = reason;
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      this.child = null;
    }
  }

  ingest(chunk: AudioChunk): VoiceActivityState {
    if (this.failedReason || !this.child) {
      return this.fallback.ingest(chunk);
    }
    try {
      this.child.stdin.write(
        `${JSON.stringify({
          pcm: Buffer.from(chunk.payload).toString('base64'),
          sr: chunk.format.sample_rate_hz,
        })}\n`
      );
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return this.fallback.ingest(chunk);
    }

    const speaking = this.lastProb >= this.probThreshold;
    const frameMs = computeChunkDurationMs(chunk);
    if (speaking) {
      this.silenceMs = 0;
      this.hadSpeechSinceEndpoint = true;
      this.endpointFired = false;
    } else {
      this.silenceMs += frameMs;
    }
    const endpoint =
      !speaking &&
      this.hadSpeechSinceEndpoint &&
      this.silenceMs >= this.endpointMs &&
      !this.endpointFired;
    if (endpoint) {
      this.endpointFired = true;
      this.hadSpeechSinceEndpoint = false;
    }
    return { speaking, silence_ms: this.silenceMs, endpoint };
  }

  reset(): void {
    this.silenceMs = 0;
    this.hadSpeechSinceEndpoint = false;
    this.endpointFired = false;
    this.fallback.reset();
    if (this.child && !this.failedReason) {
      try {
        this.child.stdin.write(`${JSON.stringify({ reset: true })}\n`);
      } catch {
        /* next ingest will fail over */
      }
    }
  }

  dispose(): void {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      this.child = null;
    }
  }
}

/** Register 'silero' in the VAD registry (probe decides availability at resolve time). */
export function installSileroVadBackend(baseOpts: SileroVadOptions = {}): void {
  registerVadBackend({
    backend_id: 'silero',
    needsCalibration: false,
    probe: () => probeSileroVad(baseOpts),
    create: (opts: VadFactoryOptions) =>
      new SileroVad({
        ...baseOpts,
        endpointMs: opts.endpointMs,
        ...(opts.rmsThreshold !== null ? { fallbackRmsThreshold: opts.rmsThreshold } : {}),
      }),
  });
}
