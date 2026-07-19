/* eslint-disable no-restricted-imports */
/**
 * Warm actuator client — talks to an actuator running in `--serve` mode
 * (see runActuatorCli) over NDJSON stdio. One resident process handles
 * many requests, so per-request node startup and engine model loading
 * are paid once per session instead of once per sentence.
 *
 * The child is spawned lazily on the first request and respawned on the
 * next request after a crash. Responses are matched by request id and
 * picked out of stdout by the serve-mode frame prefix, so interleaved
 * actuator logs are harmless.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ACTUATOR_SERVE_RESULT_PREFIX } from './cli-utils.js';
import { logger } from './core.js';
import { rootResolve } from './path-resolver.js';
import { buildSafeExecEnv } from './secure-io.js';

export interface ActuatorServeClientOptions {
  /** Full argv of the serve-mode actuator, e.g. ['node', 'dist/.../index.js', '--serve']. */
  command: string[];
  label?: string;
  /** Per-request timeout (default 120s — engine loads can be slow on first use). */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
}

export class ActuatorServeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer = '';
  private disposed = false;
  private readonly label: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly opts: ActuatorServeClientOptions) {
    if (!opts.command.length) {
      throw new Error('[actuator-serve-client] command must not be empty');
    }
    this.label = opts.label ?? opts.command[opts.command.length - 2] ?? 'actuator';
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  }

  async request(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.disposed) {
      throw new Error(`[actuator-serve-client:${this.label}] client is disposed`);
    }
    if (signal?.aborted) {
      throw new Error(`[actuator-serve-client:${this.label}] request aborted`);
    }
    const child = this.ensureChild();
    const id = randomUUID();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelPendingRequest(
          id,
          new Error(
            `[actuator-serve-client:${this.label}] request timed out after ${this.requestTimeoutMs}ms`
          ),
          true
        );
      }, this.requestTimeoutMs);
      const entry: PendingRequest = { resolve, reject, timer };
      if (signal) {
        const onAbort = () =>
          this.cancelPendingRequest(
            id,
            new Error(`[actuator-serve-client:${this.label}] request aborted`),
            true
          );
        signal.addEventListener('abort', onAbort, { once: true });
        entry.abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, entry);
    });
    try {
      child.stdin.write(`${JSON.stringify({ id, input })}\n`);
    } catch (err) {
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        entry.abortCleanup?.();
        this.pending.delete(id);
      }
      throw new Error(
        `[actuator-serve-client:${this.label}] failed to write request: ${err instanceof Error ? err.message : err}`
      );
    }
    return promise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.failAllPending(new Error(`[actuator-serve-client:${this.label}] client disposed`));
    const child = this.child;
    this.child = null;
    if (child) await this.terminateChild(child);
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const argv = this.opts.command;
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeExecEnv(),
    });
    let stderrTail = '';
    child.stderr.on('data', (data: Buffer) => {
      stderrTail = `${stderrTail}${data.toString()}`.slice(-2000);
    });
    child.stdout.on('data', (data: Buffer) => {
      this.stdoutBuffer += data.toString('utf8');
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
        const line = this.stdoutBuffer.slice(0, nl);
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        const at = line.indexOf(ACTUATOR_SERVE_RESULT_PREFIX);
        if (at === -1) continue; // actuator log line
        this.handleResponseLine(line.slice(at + ACTUATOR_SERVE_RESULT_PREFIX.length));
      }
    });
    child.on('error', (error) => {
      this.teardown(
        new Error(`[actuator-serve-client:${this.label}] spawn failed: ${error.message}`)
      );
    });
    child.on('close', (code) => {
      if (this.child === child) this.child = null;
      if (this.pending.size > 0) {
        this.failAllPending(
          new Error(
            `[actuator-serve-client:${this.label}] actuator exited code=${code}` +
              `${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ''}`
          )
        );
      }
    });
    this.child = child;
    return child;
  }

  private handleResponseLine(json: string): void {
    let parsed: { id?: unknown; ok?: boolean; result?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      logger.warn(
        `[actuator-serve-client:${this.label}] unparsable response frame: ${err instanceof Error ? err.message : err}`
      );
      return;
    }
    const id = typeof parsed.id === 'string' ? parsed.id : null;
    if (!id) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (parsed.ok) {
      entry.abortCleanup?.();
      entry.resolve((parsed.result ?? {}) as Record<string, unknown>);
    } else {
      entry.abortCleanup?.();
      entry.reject(
        new Error(
          `[actuator-serve-client:${this.label}] ${String(parsed.error ?? 'request failed')}`
        )
      );
    }
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.abortCleanup?.();
      entry.reject(error);
    }
    this.pending.clear();
  }

  private teardown(error: Error): void {
    this.failAllPending(error);
    const child = this.child;
    this.child = null;
    if (child) void this.terminateChild(child);
  }

  private cancelPendingRequest(id: string, error: Error, terminateChild: boolean): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.abortCleanup?.();
    this.pending.delete(id);
    entry.reject(error);
    if (terminateChild) {
      const child = this.child;
      this.child = null;
      this.failAllPending(error);
      if (child) void this.terminateChild(child);
    }
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin.end();
      child.kill('SIGTERM');
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish();
      }, 1500);
      child.once('close', finish);
    });
  }
}

/** Warm client for the voice actuator's built dist entry. */
export function createVoiceActuatorServeClient(
  opts: Partial<ActuatorServeClientOptions> = {}
): ActuatorServeClient {
  return new ActuatorServeClient({
    command: opts.command ?? [
      'node',
      rootResolve('dist/libs/actuators/voice-actuator/src/index.js'),
      '--serve',
    ],
    label: opts.label ?? 'voice-actuator',
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
}
