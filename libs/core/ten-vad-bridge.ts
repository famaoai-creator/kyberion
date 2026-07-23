/* eslint-disable no-restricted-imports */
/** Optional TEN VAD bridge using the upstream Python binding over NDJSON. */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildSafeExecEnv, safeExistsSync } from './secure-io.js';
import { rootResolve } from './path-resolver.js';
import { registerVadBackend, type VadFactoryOptions } from './vad-registry.js';
import {
  computeChunkDurationMs,
  EnergyVad,
  type VoiceActivityDetector,
  type VoiceActivityState,
} from './voice-activity-detector.js';
import type { AudioChunk } from './meeting-session-types.js';

export interface TenVadOptions {
  pythonBin?: string;
  scriptPath?: string;
  hopSize?: 160 | 256;
  threshold?: number;
  endpointMs?: number;
  fallbackRmsThreshold?: number;
  command?: string[];
}

export function defaultTenVadScriptPath(): string {
  return rootResolve('libs/actuators/voice-actuator/scripts/ten_vad_bridge.py');
}

function resolvePythonBin(opts: TenVadOptions): string {
  return (
    opts.pythonBin ||
    process.env.KYBERION_TEN_VAD_PYTHON ||
    process.env.KYBERION_PYTHON_BIN ||
    'python3'
  );
}

export function probeTenVad(opts: TenVadOptions = {}): { available: boolean; reason?: string } {
  if (opts.command?.length) return { available: true };
  const scriptPath = opts.scriptPath || defaultTenVadScriptPath();
  if (!safeExistsSync(scriptPath)) {
    return { available: false, reason: `TEN VAD bridge script missing at ${scriptPath}` };
  }
  const result = spawnSync(resolvePythonBin(opts), ['-c', 'import ten_vad'], {
    stdio: 'ignore',
    env: buildSafeExecEnv(),
    timeout: 5000,
  });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      reason: `TEN VAD Python binding unavailable: ${result.error?.message || `exit ${result.status}`}`,
    };
  }
  return { available: true };
}

export class TenVad implements VoiceActivityDetector {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lastProb = 0;
  private failedReason: string | null = null;
  private readonly fallback: EnergyVad;
  private readonly threshold: number;
  private readonly endpointMs: number;
  private silenceMs = 0;
  private hadSpeechSinceEndpoint = false;
  private endpointFired = false;

  constructor(private readonly opts: TenVadOptions = {}) {
    this.threshold = opts.threshold ?? 0.5;
    this.endpointMs = opts.endpointMs ?? 500;
    this.fallback = new EnergyVad({
      rms_threshold: opts.fallbackRmsThreshold ?? 800,
      endpoint_ms: this.endpointMs,
    });
    this.start();
  }

  get degradedReason(): string | null {
    return this.failedReason;
  }

  private start(): void {
    const argv = this.opts.command?.length
      ? this.opts.command
      : [
          resolvePythonBin(this.opts),
          this.opts.scriptPath || defaultTenVadScriptPath(),
          '--hop-size',
          String(this.opts.hopSize || 160),
          '--threshold',
          String(this.threshold),
        ];
    try {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeExecEnv(),
      });
      let stdoutBuffer = '';
      child.stdout.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString('utf8');
        let newline: number;
        while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as { prob?: number; error?: string };
            if (typeof parsed.prob === 'number') this.lastProb = parsed.prob;
            else if (parsed.error) this.fail(`bridge error: ${parsed.error}`);
          } catch {
            /* Ignore library noise; the bridge emits JSON responses. */
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
            `TEN VAD bridge exited code=${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}`
          );
        }
      });
      this.child = child;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
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
    if (this.failedReason || !this.child) return this.fallback.ingest(chunk);
    try {
      this.child.stdin.write(
        `${JSON.stringify({
          pcm: Buffer.from(chunk.payload).toString('base64'),
          sr: chunk.format.sample_rate_hz,
        })}\n`
      );
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return this.fallback.ingest(chunk);
    }
    const speaking = this.lastProb >= this.threshold;
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
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}

export function installTenVadBackend(baseOpts: TenVadOptions = {}): void {
  registerVadBackend({
    backend_id: 'ten_vad',
    needsCalibration: false,
    probe: () => probeTenVad(baseOpts),
    create: (opts: VadFactoryOptions) =>
      new TenVad({
        ...baseOpts,
        endpointMs: opts.endpointMs,
        ...(opts.rmsThreshold !== null ? { fallbackRmsThreshold: opts.rmsThreshold } : {}),
      }),
  });
}
