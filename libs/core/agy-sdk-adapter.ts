/* eslint-disable no-restricted-imports -- the provider boundary owns this managed bridge process. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentAskOptions, AgentResponse } from './agent-adapter.js';
import { buildProviderChildEnv } from './provider-permission-profiles.js';
import * as pathResolver from './path-resolver.js';
import { resolveManagedToolPythonBin } from './tool-runtime-registry.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/json.js';
import { isRecord } from './foundation/text.js';

interface BridgeResponse {
  id?: string;
  ok?: boolean;
  text?: string;
  thought?: string;
  stopReason?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

type AgySdkBridgeMessage = BridgeResponse & {
  event?: 'ready' | 'error';
  pid?: number;
  sdk?: string;
};

/** Normalize one boot/request response emitted by the AGY SDK bridge. */
export function normalizeAgySdkBridgeMessage(value: unknown): AgySdkBridgeMessage | null {
  if (!isRecord(value)) return null;

  const id = optionalString(value.id);
  if (id === null) return null;
  const event = optionalEvent(value.event);
  if (event === null) return null;
  const ok = optionalBoolean(value.ok);
  if (ok === null) return null;
  const text = optionalString(value.text);
  if (text === null) return null;
  const thought = optionalString(value.thought);
  if (thought === null) return null;
  const stopReason = optionalString(value.stopReason);
  if (stopReason === null) return null;
  const error = optionalString(value.error);
  if (error === null) return null;
  const sdk = optionalString(value.sdk);
  if (sdk === null) return null;

  const pid = value.pid;
  if (
    pid !== undefined &&
    (typeof pid !== 'number' || !Number.isInteger(pid) || !Number.isFinite(pid) || pid <= 0)
  ) {
    return null;
  }
  const normalizedPid: number | undefined = typeof pid === 'number' ? pid : undefined;

  const metadata = value.metadata;
  const normalizedMetadata =
    metadata === undefined ? undefined : isRecord(metadata) ? metadata : null;
  if (normalizedMetadata === null) return null;
  if (event === undefined && id === undefined) return null;

  return {
    ...(id !== undefined ? { id } : {}),
    ...(ok !== undefined ? { ok } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(thought !== undefined ? { thought } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(normalizedMetadata !== undefined ? { metadata: normalizedMetadata } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(normalizedPid !== undefined ? { pid: normalizedPid } : {}),
    ...(sdk !== undefined ? { sdk } : {}),
  };
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? value : null;
}

function optionalEvent(value: unknown): 'ready' | 'error' | undefined | null {
  if (value === undefined) return undefined;
  return value === 'ready' || value === 'error' ? value : null;
}

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  child?: ChildProcessWithoutNullStreams;
}

export interface AgySdkAdapterOptions {
  pythonBin?: string;
  scriptPath?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Test seam; production uses the standard child process implementation. */
  spawnProcess?: typeof spawn;
}

/**
 * AGY's concrete native-subagent adopter.
 *
 * The official Antigravity SDK is Python, so this adapter talks to a small
 * long-lived NDJSON bridge. Provider-specific SDK types and tool-hook logic
 * remain entirely behind this boundary.
 */
export class AgySdkAdapter {
  private readonly options: Required<Pick<AgySdkAdapterOptions, 'cwd' | 'timeoutMs'>> &
    Omit<AgySdkAdapterOptions, 'cwd' | 'timeoutMs'>;
  private process?: ChildProcessWithoutNullStreams;
  private bootPromise?: Promise<void>;
  private bootChild?: ChildProcessWithoutNullStreams;
  private bootReject?: (error: Error) => void;
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private ready = false;
  private runtimeInfo: Record<string, unknown> = {
    provider: 'agy',
    mode: 'antigravity-sdk',
    supportsNativeSubagents: false,
  };
  private stdoutBuffer = '';

  constructor(options: AgySdkAdapterOptions = {}) {
    this.options = {
      ...options,
      cwd: options.cwd ?? pathResolver.rootDir(),
      timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
    };
  }

  async boot(): Promise<void> {
    if (this.ready) return;
    if (this.bootPromise) return this.bootPromise;
    let child: ChildProcessWithoutNullStreams | undefined;
    this.bootPromise = new Promise<void>((resolve, reject) => {
      this.bootReject = reject;
      const python =
        this.options.pythonBin ??
        getRegisteredEnvText('KYBERION_AGY_SDK_PYTHON') ??
        resolveManagedToolPythonBin('agy_sdk') ??
        'python3';
      const script = this.options.scriptPath ?? pathResolver.scripts('agy_sdk_subagent_bridge.py');
      const sdkApiKey =
        getRegisteredEnvText('GEMINI_API_KEY') ?? getRegisteredEnvText('GOOGLE_API_KEY');
      child = (this.options.spawnProcess ?? spawn)(python, [script], {
        cwd: this.options.cwd,
        env: {
          ...buildProviderChildEnv({ provider: 'agy' }),
          KYBERION_AGY_SDK_CWD: this.options.cwd,
          PYTHONUNBUFFERED: '1',
          ...(sdkApiKey ? { KYBERION_AGY_SDK_API_KEY: sdkApiKey } : {}),
        },
        stdio: 'pipe',
        shell: false,
      }) as ChildProcessWithoutNullStreams;
      this.process = child;
      this.bootChild = child;
      this.runtimeInfo = {
        ...this.runtimeInfo,
        pid: child.pid,
        python,
        script,
        cwd: this.options.cwd,
      };

      child.stdout.on('data', (chunk: Buffer | string) =>
        this.consumeStdout(String(chunk), resolve, reject)
      );
      child.stderr.on('data', () => {
        // Keep provider diagnostics out of the NDJSON protocol. The bridge
        // sends actionable failures on stdout as structured responses.
      });
      child.once('error', (error) => {
        const isBooting = this.bootChild === child;
        this.rejectAll(error, child);
        if (isBooting) {
          reject(this.unavailable(error.message));
        }
      });
      child.once('close', (code, signal) => {
        const isCurrent = this.process === child;
        const isBooting = this.bootChild === child;
        if (isCurrent) {
          this.process = undefined;
          this.bootPromise = undefined;
          this.ready = false;
        }
        const error = this.unavailable(
          `SDK bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
        );
        this.rejectAll(error, child);
        if (isBooting) {
          this.bootChild = undefined;
          this.bootReject = undefined;
          reject(error);
        }
      });
    })
      .then(() => {
        if (!child || this.process !== child) {
          throw this.unavailable('AGY SDK bridge was superseded before boot completed.');
        }
        if (this.bootChild === child) {
          this.bootChild = undefined;
          this.bootReject = undefined;
        }
        this.ready = true;
        this.runtimeInfo = { ...this.runtimeInfo, supportsNativeSubagents: true };
      })
      .catch((err) => {
        this.bootPromise = undefined;
        if (this.process === child) {
          this.ready = false;
          try {
            child?.stdin?.end();
            child?.kill();
          } catch {
            // best-effort cleanup
          }
          this.process = undefined;
        }
        if (this.bootChild === child) {
          this.bootChild = undefined;
          this.bootReject = undefined;
        }
        throw err;
      });
    return this.bootPromise;
  }

  async ask(_prompt: string, _options?: AgentAskOptions): Promise<AgentResponse> {
    throw this.unavailable('AGY SDK adapter exposes native delegation only.');
  }

  async askNativeSubagent(prompt: string, options: AgentAskOptions = {}): Promise<AgentResponse> {
    await this.boot();
    const profile = String(options.profile ?? 'explorer');
    const response = await this.request(
      {
        op: 'ask',
        prompt,
        profile,
        effort: options.effort ?? 'medium',
      },
      options.signal
    );
    if (!response.ok) throw this.unavailable(response.error ?? 'SDK bridge rejected the request.');
    return {
      text: response.text ?? '',
      thought: response.thought,
      stopReason: response.stopReason ?? 'completed',
      metadata: response.metadata,
    };
  }

  getRuntimeInfo(): Record<string, unknown> {
    return { ...this.runtimeInfo };
  }

  async shutdown(): Promise<void> {
    const child = this.process;
    const bootChild = this.bootChild;
    const bootReject = this.bootReject;
    this.process = undefined;
    this.ready = false;
    this.bootPromise = undefined;
    this.bootChild = undefined;
    this.bootReject = undefined;
    if (child && bootChild === child) {
      bootReject?.(this.unavailable('AGY SDK adapter shut down during boot.'));
    }
    this.rejectAll(this.unavailable('AGY SDK adapter shut down.'));
    if (!child || child.exitCode != null || child.signalCode != null) return;

    await new Promise<void>((resolve) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (!done) {
          try {
            child.kill('SIGKILL');
          } catch {
            // best-effort
          }
          cleanup();
        }
      }, 2000);

      child.once('close', cleanup);

      try {
        if (child.stdin.writable && !child.stdin.writableEnded) {
          child.stdin.end();
        }
        setTimeout(() => {
          if (!done && child.exitCode == null && child.signalCode == null) {
            try {
              child.kill('SIGTERM');
            } catch {
              // best-effort
            }
          }
        }, 300);
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // best-effort
        }
        cleanup();
      }
    });
  }

  private request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeResponse> {
    const child = this.process;
    if (!child || !this.ready)
      return Promise.reject(this.unavailable('AGY SDK bridge is not ready.'));
    if (signal?.aborted) return Promise.reject(this.unavailable('AGY SDK request aborted.'));
    const id = `agy-sdk-${++this.sequence}`;
    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ id: `${id}-cancel`, op: 'cancel' });
        reject(this.unavailable('AGY SDK request timed out.'));
      }, this.options.timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer, child };
      this.pending.set(id, pending);
      const onAbort = () => {
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        clearTimeout(timer);
        this.send({ id: `${id}-cancel`, op: 'cancel' });
        reject(this.unavailable('AGY SDK request aborted.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.send({ id, ...payload })) {
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        clearTimeout(timer);
        reject(this.unavailable('AGY SDK bridge stdin is closed.'));
      }
    });
  }

  private send(payload: Record<string, unknown>): boolean {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  private consumeStdout(
    chunk: string,
    resolveBoot: () => void,
    rejectBoot: (error: Error) => void
  ): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.consumeMessage(line, resolveBoot, rejectBoot);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private consumeMessage(
    line: string,
    resolveBoot: () => void,
    rejectBoot: (error: Error) => void
  ): void {
    let message: AgySdkBridgeMessage | null;
    try {
      message = normalizeAgySdkBridgeMessage(parseSafeJsonInput(line, 'AGY SDK bridge message'));
    } catch {
      rejectBoot(this.unavailable('AGY SDK bridge emitted invalid JSON.'));
      return;
    }
    if (!message) {
      rejectBoot(this.unavailable('AGY SDK bridge emitted an invalid response shape.'));
      return;
    }
    if (message.event === 'ready') {
      this.runtimeInfo = { ...this.runtimeInfo, sdk: message.sdk, pid: message.pid };
      resolveBoot();
      return;
    }
    if (message.event === 'error') {
      rejectBoot(this.unavailable(message.error ?? 'AGY SDK bridge failed to boot.'));
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private rejectAll(error: Error, targetChild?: ChildProcessWithoutNullStreams): void {
    for (const [id, pending] of this.pending) {
      if (!targetChild || pending.child === targetChild) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
  }

  private unavailable(message: string): Error {
    return message.startsWith('[SUBAGENT_UNAVAILABLE]')
      ? new Error(message)
      : new Error(`[SUBAGENT_UNAVAILABLE] ${message}`);
  }
}
