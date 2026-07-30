/* eslint-disable no-restricted-imports -- the provider boundary owns this managed bridge process. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import type { AgentAskOptions, AgentResponse } from './agent-adapter.js';
import { buildProviderChildEnv } from './provider-permission-profiles.js';
import * as pathResolver from './path-resolver.js';
import { resolveManagedToolPythonBin } from './tool-runtime-registry.js';

interface BridgeResponse {
  id?: string;
  ok?: boolean;
  text?: string;
  thought?: string;
  stopReason?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
    this.bootPromise = new Promise<void>((resolve, reject) => {
      const python =
        this.options.pythonBin ??
        process.env.KYBERION_AGY_SDK_PYTHON ??
        resolveManagedToolPythonBin('agy_sdk') ??
        'python3';
      const script = this.options.scriptPath ?? pathResolver.scripts('agy_sdk_subagent_bridge.py');
      const sdkApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
      const child = (this.options.spawnProcess ?? spawn)(python, [script], {
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
        this.rejectAll(error);
        reject(this.unavailable(error.message));
      });
      child.once('close', (code, signal) => {
        this.ready = false;
        const error = this.unavailable(
          `SDK bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
        );
        this.rejectAll(error);
        if (!this.ready) reject(error);
      });
    }).then(() => {
      this.ready = true;
      this.runtimeInfo = { ...this.runtimeInfo, supportsNativeSubagents: true };
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
    this.process = undefined;
    this.ready = false;
    this.bootPromise = undefined;
    this.rejectAll(this.unavailable('AGY SDK adapter shut down.'));
    if (!child) return;
    child.stdin.end();
    child.kill();
  }

  private request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeResponse> {
    const child = this.process;
    if (!child || !this.ready)
      return Promise.reject(this.unavailable('AGY SDK bridge is not ready.'));
    if (signal?.aborted) return Promise.reject(this.unavailable('AGY SDK request aborted.'));
    const id = `agy-sdk-${++this.sequence}`;
    const request = JSON.stringify({ id, ...payload });
    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ id: `${id}-cancel`, op: 'cancel' });
        reject(this.unavailable('AGY SDK request timed out.'));
      }, this.options.timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer };
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
    let message: BridgeResponse & { event?: string; pid?: number; sdk?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      rejectBoot(this.unavailable('AGY SDK bridge emitted invalid JSON.'));
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

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private unavailable(message: string): Error {
    return message.startsWith('[SUBAGENT_UNAVAILABLE]')
      ? new Error(message)
      : new Error(`[SUBAGENT_UNAVAILABLE] ${message}`);
  }
}
