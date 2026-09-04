/**
 * Codex App Server adapter.
 *
 * The app-server protocol owns a separate lifecycle from the other provider
 * adapters: JSON-RPC transport, thread/turn state, approval projection, and
 * native subagent threading all live here. The public agent-adapter module
 * re-exports this boundary so existing consumers keep their canonical import.
 */

import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { parseSafeJsonInput } from './foundation/json.js';
import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExecResult } from './secure-io.js';
import { spawnManagedProcess, stopManagedProcess, touchManagedProcess } from './managed-process.js';
import { resolveCodexBinary } from './codex-cli-query.js';
import { loadAgentInstructionResource } from './agent-instruction-loader.js';
import { resolveSandboxPolicy, toCodexSandboxPolicy } from './sandbox-policy.js';
import { safeChildEnv } from './foundation/env.js';
import { isRecord } from './foundation/text.js';
import type {
  AgentAdapter,
  AgentAskOptions,
  AgentEnhancer,
  AgentResponse,
} from './agent-adapter.js';

const logger = createLogger('codex-app-server-adapter');
const PROJECT_ROOT = pathResolver.rootDir();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNestedString(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return readString(current);
}

interface CodexAppServerMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Normalize one JSON-RPC envelope emitted by the Codex app server. */
export function normalizeCodexAppServerMessage(value: unknown): CodexAppServerMessage | null {
  if (!isRecord(value)) return null;
  if (value.jsonrpc !== undefined && value.jsonrpc !== '2.0') return null;

  let id: number | string | undefined;
  if (value.id !== undefined) {
    if (typeof value.id === 'number') {
      if (!Number.isFinite(value.id)) return null;
      id = value.id;
    } else if (typeof value.id === 'string' && value.id.length > 0) {
      id = value.id;
    } else {
      return null;
    }
  }

  let method: string | undefined;
  if (value.method !== undefined) {
    if (typeof value.method !== 'string' || value.method.length === 0) return null;
    method = value.method;
  }

  let params: Record<string, unknown> | undefined;
  if (value.params !== undefined) {
    if (!isRecord(value.params)) return null;
    params = value.params;
  }

  let error: CodexAppServerMessage['error'];
  if (value.error !== undefined) {
    if (!isRecord(value.error)) return null;
    const code = value.error.code;
    if (code !== undefined) {
      if (typeof code !== 'number' || !Number.isFinite(code)) return null;
    }
    const message = value.error.message;
    if (message !== undefined && typeof message !== 'string') return null;
    const normalizedCode: number | undefined = typeof code === 'number' ? code : undefined;
    const normalizedMessage: string | undefined = typeof message === 'string' ? message : undefined;
    error = {
      ...(normalizedCode !== undefined ? { code: normalizedCode } : {}),
      ...(normalizedMessage !== undefined ? { message: normalizedMessage } : {}),
      ...(value.error.data !== undefined ? { data: value.error.data } : {}),
    };
  }

  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  if (hasResult && error !== undefined) return null;
  if (id === undefined && method === undefined) return null;
  if (id !== undefined && method === undefined && !hasResult && error === undefined) return null;

  return {
    ...(value.jsonrpc !== undefined ? { jsonrpc: '2.0' } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(params !== undefined ? { params } : {}),
    ...(hasResult ? { result: value.result } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function registerEnhancer(enhancers: AgentEnhancer[], enhancer: AgentEnhancer): void {
  enhancers.push(enhancer);
  logger.info('[UAA] Enhancer added: ' + enhancer.name);
}

async function applyEnhancersBeforeAsk(
  enhancers: AgentEnhancer[],
  prompt: string,
  options?: AgentAskOptions,
  trace: Array<{ enhancer: string; action: string; details?: string }> = []
): Promise<{ prompt: string; options: AgentAskOptions }> {
  let currentPrompt = prompt;
  let currentOptions: AgentAskOptions = { ...options };
  for (const enhancer of enhancers) {
    if (!enhancer.onBeforeAsk) continue;
    const originalPrompt = currentPrompt;
    const enhanced = await enhancer.onBeforeAsk(currentPrompt, currentOptions);
    currentPrompt = enhanced.prompt;
    currentOptions = { ...currentOptions, ...(enhanced.options || {}) };
    if (currentPrompt !== originalPrompt) {
      trace.push({
        enhancer: enhancer.name,
        action: 'modify_prompt',
        details: 'Diff: ' + (currentPrompt.length - originalPrompt.length) + ' chars',
      });
    }
  }
  return { prompt: currentPrompt, options: currentOptions };
}

async function applyEnhancersAfterAsk(
  enhancers: AgentEnhancer[],
  response: AgentResponse
): Promise<AgentResponse> {
  let next = response;
  const trace = next.trace || [];
  for (const enhancer of enhancers) {
    if (!enhancer.onAfterAsk) continue;
    next = await enhancer.onAfterAsk(next);
    trace.push({ enhancer: enhancer.name, action: 'modify_response' });
  }
  next.trace = trace;
  return next;
}

export interface CodexExecutionEnhancerOptions {
  maxContractChars?: number;
}

/**
 * Codex-specific add-on: injects repository execution contract context.
 */
export class CodexExecutionEnhancer implements AgentEnhancer {
  public name = 'CodexExecutionEnhancer';
  private cachedContext: string | null = null;

  constructor(private options: CodexExecutionEnhancerOptions = {}) {}

  public async onBeforeAsk(
    prompt: string,
    options?: AgentAskOptions
  ): Promise<{ prompt: string; options?: AgentAskOptions }> {
    const context = this.loadExecutionContext();
    if (!context) return { prompt, options };
    const enhancedPrompt =
      '\n<codex_execution_context>\n' +
      context +
      '\n</codex_execution_context>\n\nUser Request:\n' +
      prompt;
    return { prompt: enhancedPrompt, options };
  }

  private loadExecutionContext(): string {
    if (this.cachedContext !== null) return this.cachedContext;
    const maxChars = this.options.maxContractChars || 4000;
    const agents = loadAgentInstructionResource(PROJECT_ROOT, { trustResolved: false });
    if (!agents) {
      this.cachedContext = '';
      return this.cachedContext;
    }
    try {
      const header = [
        'Repository execution contract (excerpt):',
        '- Follow AGENTS.md repository rules.',
        '- Prefer non-destructive deterministic operations.',
        '- Preserve existing unrelated changes.',
      ].join('\n');
      const excerpt = agents.content.slice(0, maxChars).trim();
      this.cachedContext = header + '\n\n' + excerpt;
      return this.cachedContext;
    } catch (error: unknown) {
      logger.warn('[CodexEnhancer] Failed to load AGENTS.md context: ' + errorMessage(error));
      this.cachedContext = '';
      return this.cachedContext;
    }
  }
}

export interface CodexAppServerAdapterOptions {
  model?: string;
  modelProvider?: string;
  cwd?: string;
  systemPrompt?: string;
  approvalPolicy?: string;
  timeoutMs?: number;
  approvalMode?: 'strict' | 'relaxed';
  sandboxMode?: 'workspace-write' | 'read-only' | 'danger-full-access';
  networkAccess?: boolean;
  writableRoots?: string[];
}

export interface CodexNativeSubagentInfo {
  provider: 'codex';
  model?: string;
  parentThreadId: string;
  threadId: string;
  turnId?: string;
  forked: boolean;
  mode: 'thread-fork' | 'parent-turn';
  effort: 'low' | 'medium' | 'high' | 'ultra';
}

/**
 * Codex App Server Adapter (JSON-RPC over stdio).
 */
export class CodexAppServerAdapter implements AgentAdapter {
  private options: CodexAppServerAdapterOptions;
  private child: ChildProcess | null = null;
  private runtimeResourceId: string | null = null;
  private buffer = '';
  private nextId = 1;
  private pendingRequests: Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private pendingTurn: {
    turnId: string;
    threadId: string;
    resolve: (res: AgentResponse) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    abortCleanup?: () => void;
  } | null = null;
  private accumulatedText = '';
  private sawAgentDelta = false;
  private logBuffer: { ts: number; type: string; content: string }[] = [];
  private earlyTurnResults: Map<string, { text: string; stopReason: string }> = new Map();
  private projectRoot: string = PROJECT_ROOT;
  private usageSummary: Record<string, unknown> | null = null;
  private nativeMultiAgentMode: unknown = null;
  private activeThreadId: string | null = null;
  private lastNativeSubagentInfo: CodexNativeSubagentInfo | null = null;
  private activeApprovalMode: 'strict' | 'relaxed' | undefined;
  private enhancers: AgentEnhancer[] = [];
  private codexBinary: string | null = null;
  private codexVersion = 'unknown';

  constructor(options?: CodexAppServerAdapterOptions) {
    this.options = options || {};
    this.addEnhancer(new CodexExecutionEnhancer());
  }

  public addEnhancer(enhancer: AgentEnhancer): void {
    registerEnhancer(this.enhancers, enhancer);
  }

  public getLog(limit = 50): { ts: number; type: string; content: string }[] {
    return this.logBuffer.slice(-limit);
  }

  private getSandboxMode(): 'workspace-write' | 'read-only' | 'danger-full-access' {
    return this.options.sandboxMode || 'workspace-write';
  }

  private buildSandboxPolicy():
    | { type: 'dangerFullAccess' }
    | { type: 'readOnly'; networkAccess: boolean }
    | {
        type: 'workspaceWrite';
        writableRoots?: string[];
        networkAccess: boolean;
        excludeTmpdirEnvVar: boolean;
        excludeSlashTmp: boolean;
      } {
    return toCodexSandboxPolicy(
      resolveSandboxPolicy({
        provider: 'codex',
        mode: this.getSandboxMode(),
        networkAccess: this.options.networkAccess ?? true,
        writableRoots: this.options.writableRoots,
      })
    ) as ReturnType<CodexAppServerAdapter['buildSandboxPolicy']>;
  }

  public async boot(): Promise<void> {
    const cwd = this.resolveCwd();
    logger.info('[UAA] Codex App Server booting (cwd: ' + cwd + ')');
    this.runtimeResourceId = 'codex-app-server:' + cwd;
    this.codexBinary = resolveCodexBinary(process.env);
    const versionResult = safeExecResult(this.codexBinary, ['--version'], {
      env: safeChildEnv() as NodeJS.ProcessEnv,
      cwd,
      timeoutMs: 5000,
    });
    this.codexVersion =
      (versionResult.stdout || versionResult.stderr).trim().split(/\r?\n/u)[0] || 'unknown';
    const managed = spawnManagedProcess({
      resourceId: this.runtimeResourceId,
      kind: 'agent',
      ownerId: cwd,
      ownerType: 'agent-adapter',
      command: this.codexBinary,
      args: ['app-server', '--listen', 'stdio://'],
      shutdownPolicy: 'manual',
      spawnOptions: {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeChildEnv() as NodeJS.ProcessEnv,
      },
      metadata: { cwd },
    });
    this.child = managed.child;
    this.child.stdout?.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr?.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) {
        const kind = /codex_models_manager|base_instructions/i.test(msg)
          ? 'UAA_CODEX_MODEL_CACHE_WARN'
          : 'UAA_CODEX_ERR';
        logger.warn('[' + kind + '] ' + msg);
      }
      if (this.runtimeResourceId) touchManagedProcess(this.runtimeResourceId);
    });
    this.child.on('exit', (code, signal) => {
      const err = new Error(
        'Codex app-server exited (code=' + (code ?? 'null') + ', signal=' + (signal ?? 'null') + ')'
      );
      for (const pending of this.pendingRequests.values()) {
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.reject(err);
      }
      this.pendingRequests.clear();
      if (this.pendingTurn) {
        clearTimeout(this.pendingTurn.timeout);
        this.pendingTurn.abortCleanup?.();
        this.pendingTurn.reject(err);
        this.pendingTurn = null;
      }
    });

    const bootTimeoutMs = this.options.timeoutMs ?? 20000;
    await this.sendRequest(
      'initialize',
      {
        clientInfo: { name: 'Kyberion', version: '1.0.0' },
        capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
      },
      bootTimeoutMs
    );
    const approvalMode = this.options.approvalMode || 'strict';
    const sandboxMode = this.getSandboxMode();
    const threadRes = await this.sendRequest<unknown>(
      'thread/start',
      {
        model: this.options.model ?? undefined,
        modelProvider: this.options.modelProvider ?? undefined,
        cwd,
        approvalPolicy:
          this.options.approvalPolicy ?? (approvalMode === 'relaxed' ? 'never' : 'on-request'),
        sandbox: sandboxMode,
        developerInstructions: this.options.systemPrompt ?? undefined,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
      bootTimeoutMs
    );
    this.threadId =
      readNestedString(threadRes, 'thread', 'id') ??
      readNestedString(threadRes, 'threadId') ??
      null;
    if (!this.threadId) {
      throw new Error(
        'Codex app-server thread/start missing thread id: ' + JSON.stringify(threadRes)
      );
    }
    this.activeThreadId = this.threadId;
    this.nativeMultiAgentMode = isRecord(threadRes)
      ? (threadRes.multiAgentMode ??
        (isRecord(threadRes.thread) ? threadRes.thread.multiAgentMode : null))
      : null;
    logger.info('[UAA] Codex App Server ready. Thread: ' + this.threadId);
  }

  public async ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse> {
    if (!this.threadId) throw new Error('Codex app-server not booted.');
    return this.askOnThread(prompt, options, this.threadId);
  }

  public async askNativeSubagent(
    prompt: string,
    options?: AgentAskOptions
  ): Promise<AgentResponse> {
    if (!this.threadId) throw new Error('Codex app-server not booted.');
    const parentThreadId = this.threadId;
    const effort = options?.effort ?? 'medium';
    let targetThreadId = parentThreadId;
    let forked = false;
    try {
      const forkResponse = await this.sendRequest<unknown>(
        'thread/fork',
        { threadId: parentThreadId },
        this.options.timeoutMs ?? 20000
      );
      targetThreadId =
        readNestedString(forkResponse, 'thread', 'id') ??
        readNestedString(forkResponse, 'threadId') ??
        readNestedString(forkResponse, 'id') ??
        '';
      if (!targetThreadId) throw new Error('Codex app-server thread/fork missing thread id.');
      forked = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no rollout found|rollout.*not found/i.test(message)) {
        throw new Error('[SUBAGENT_UNAVAILABLE] Codex thread/fork failed: ' + message);
      }
    }
    const response = await this.askOnThread(
      prompt,
      { ...options, effort, subagent: true },
      targetThreadId
    );
    const info: CodexNativeSubagentInfo = {
      provider: 'codex',
      ...(this.options.model ? { model: this.options.model } : {}),
      parentThreadId,
      threadId: targetThreadId,
      ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      forked,
      mode: forked ? 'thread-fork' : 'parent-turn',
      effort,
    };
    this.lastNativeSubagentInfo = info;
    return { ...response, metadata: { ...(response.metadata || {}), nativeSubagent: info } };
  }

  private async askOnThread(
    prompt: string,
    options: AgentAskOptions | undefined,
    targetThreadId: string
  ): Promise<AgentResponse> {
    if (this.pendingTurn) throw new Error('Codex app-server is already processing a turn.');
    if (options?.signal?.aborted) throw new Error('Codex app-server turn cancelled before start.');
    this.activeThreadId = targetThreadId;
    this.activeApprovalMode = options?.approvalMode ?? this.options.approvalMode;
    const trace: Array<{ enhancer: string; action: string; details?: string }> = [];
    const enhanced = await applyEnhancersBeforeAsk(this.enhancers, prompt, options, trace);
    this.accumulatedText = '';
    this.sawAgentDelta = false;
    this.logBuffer.push({ ts: Date.now(), type: 'prompt', content: enhanced.prompt });
    const turnRes = await this.sendRequest<unknown>(
      'turn/start',
      {
        threadId: targetThreadId,
        input: [{ type: 'text', text: enhanced.prompt, text_elements: [] }],
        model: this.options.model ?? undefined,
        cwd: this.options.cwd ?? undefined,
        sandboxPolicy: this.buildSandboxPolicy(),
        ...(options?.subagent ? { effort: options.effort ?? 'medium' } : {}),
        ...enhanced.options,
      },
      this.options.timeoutMs ?? 20000
    );
    const turnId = readNestedString(turnRes, 'turn', 'id') ?? readNestedString(turnRes, 'turnId');
    if (turnId) this.currentTurnId = turnId;
    if (!turnId) {
      throw new Error('Codex app-server turn/start missing turn id: ' + JSON.stringify(turnRes));
    }
    const early = this.earlyTurnResults.get(turnId);
    if (early) {
      this.earlyTurnResults.delete(turnId);
      return applyEnhancersAfterAsk(this.enhancers, {
        text: early.text,
        stopReason: early.stopReason,
        trace,
      });
    }

    const timeoutMs = this.options.timeoutMs ?? 300000;
    const raw = await new Promise<AgentResponse>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options?.signal?.removeEventListener('abort', onAbort);
      };
      const settleReject = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        if (this.pendingTurn?.turnId !== turnId) return;
        this.pendingTurn = null;
        cleanup();
        void this.interruptTurn(targetThreadId, turnId);
        reject(new Error('Codex app-server turn cancelled.'));
      };
      timeout = setTimeout(() => {
        if (this.pendingTurn?.turnId !== turnId) return;
        this.pendingTurn = null;
        cleanup();
        void this.interruptTurn(targetThreadId, turnId);
        settleReject(new Error('Codex app-server turn timed out.'));
      }, timeoutMs);
      this.pendingTurn = {
        turnId,
        threadId: targetThreadId,
        resolve,
        reject,
        timeout,
        abortCleanup: cleanup,
      };
      if (options?.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    });
    return applyEnhancersAfterAsk(this.enhancers, raw);
  }

  public async shutdown(): Promise<void> {
    if (this.child) {
      if (this.runtimeResourceId) stopManagedProcess(this.runtimeResourceId, this.child);
      this.child = null;
    }
    this.runtimeResourceId = null;
    this.activeApprovalMode = undefined;
    this.activeThreadId = null;
    this.lastNativeSubagentInfo = null;
  }

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      pid: this.child?.pid,
      codexBinary: this.codexBinary,
      codexVersion: this.codexVersion,
      threadId: this.threadId,
      activeThreadId: this.activeThreadId,
      usage: this.usageSummary,
      nativeMultiAgentMode: this.nativeMultiAgentMode,
      lastNativeSubagent: this.lastNativeSubagentInfo,
      supportsNativeSubagents: this.nativeMultiAgentMode !== null,
      supportsSoftRefresh: true,
    };
  }

  public async refreshContext(): Promise<{ mode: 'soft'; threadId?: string | null }> {
    if (!this.child) throw new Error('Codex app-server not booted.');
    const cwd = this.resolveCwd();
    const approvalMode = this.options.approvalMode || 'strict';
    const sandboxMode = this.getSandboxMode();
    const threadRes = await this.sendRequest<unknown>(
      'thread/start',
      {
        model: this.options.model ?? undefined,
        modelProvider: this.options.modelProvider ?? undefined,
        cwd,
        approvalPolicy:
          this.options.approvalPolicy ?? (approvalMode === 'relaxed' ? 'never' : 'on-request'),
        sandbox: sandboxMode,
        developerInstructions: this.options.systemPrompt ?? undefined,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
      this.options.timeoutMs ?? 20000
    );
    this.threadId =
      readNestedString(threadRes, 'thread', 'id') ??
      readNestedString(threadRes, 'threadId') ??
      null;
    this.activeThreadId = this.threadId;
    return { mode: 'soft', threadId: this.threadId };
  }

  private handleStdout(chunk: Buffer): void {
    if (this.runtimeResourceId) touchManagedProcess(this.runtimeResourceId);
    this.buffer += chunk.toString();
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        try {
          const msg = normalizeCodexAppServerMessage(
            parseSafeJsonInput(line, 'Codex app-server message')
          );
          if (msg) this.handleMessage(msg);
        } catch (error: unknown) {
          logger.warn('[UAA_CODEX_PARSE] Failed to parse JSON: ' + errorMessage(error));
        }
      }
      newlineIdx = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(msg: CodexAppServerMessage): void {
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    const hasMethod = Object.prototype.hasOwnProperty.call(msg, 'method');
    const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(msg, 'error');
    if (hasId && (hasResult || hasError)) {
      if (msg.id === undefined) return;
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (pending.timeout) clearTimeout(pending.timeout);
        if (hasError) {
          const errMsg = msg.error?.message || 'Codex app-server error';
          pending.reject(new Error(errMsg));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    if (hasMethod && hasId) {
      void this.handleServerRequest(msg);
      return;
    }
    if (hasMethod) this.handleNotification(msg);
  }

  private handleNotification(msg: CodexAppServerMessage): void {
    const method = msg.method;
    const params = msg.params || {};
    if (method === 'item/agentMessage/delta') {
      const activeThreadId = this.activeThreadId || this.threadId;
      if (activeThreadId && params.threadId && params.threadId !== activeThreadId) return;
      if (this.currentTurnId && params.turnId && params.turnId !== this.currentTurnId) return;
      if (typeof params.delta === 'string') {
        this.sawAgentDelta = true;
        this.accumulatedText += params.delta;
      }
      return;
    }
    if (method === 'rawResponseItem/completed') {
      const activeThreadId = this.activeThreadId || this.threadId;
      if (activeThreadId && params.threadId && params.threadId !== activeThreadId) return;
      if (this.currentTurnId && params.turnId && params.turnId !== this.currentTurnId) return;
      const item = isRecord(params.item) ? params.item : null;
      if (!this.sawAgentDelta && item?.type === 'message' && item.role === 'assistant') {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content
          .filter((contentItem): contentItem is Record<string, unknown> => isRecord(contentItem))
          .filter((contentItem) => contentItem.type === 'output_text')
          .map((contentItem) => contentItem.text)
          .filter((contentItem): contentItem is string => typeof contentItem === 'string')
          .join('');
        if (text) this.accumulatedText += text;
      }
      const usage = extractUsageSummary(params);
      if (usage) this.usageSummary = usage;
      return;
    }
    if (method === 'turn/started') {
      const turn = isRecord(params.turn) ? params.turn : null;
      const turnId = readString(turn?.id);
      if (turnId) this.currentTurnId = turnId;
      return;
    }
    if (method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : null;
      const turnId = readString(turn?.id);
      if (!turnId) return;
      const status =
        turn?.status === 'failed' || turn?.status === 'interrupted' ? turn.status : 'completed';
      const stopReason =
        status === 'failed' ? 'error' : status === 'interrupted' ? 'interrupted' : 'completed';
      const finalText = this.accumulatedText;
      this.logBuffer.push({ ts: Date.now(), type: 'agent', content: finalText.slice(0, 500) });
      if (this.logBuffer.length > 200) this.logBuffer = this.logBuffer.slice(-200);
      const result = { text: finalText, stopReason };
      const usage = extractUsageSummary(params);
      if (usage) this.usageSummary = usage;
      if (this.pendingTurn && this.pendingTurn.turnId === turnId) {
        const pending = this.pendingTurn;
        clearTimeout(pending.timeout);
        pending.abortCleanup?.();
        this.pendingTurn = null;
        pending.resolve(result);
      } else {
        this.earlyTurnResults.set(turnId, result);
      }
      return;
    }
    if (method === 'error') {
      logger.error('[UAA_CODEX_ERR] ' + JSON.stringify(params));
    }
  }

  private async handleServerRequest(msg: CodexAppServerMessage): Promise<void> {
    const { id, method, params } = msg;
    if (id === undefined) return;
    const relaxed = (this.activeApprovalMode ?? this.options.approvalMode) === 'relaxed';
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const allow = relaxed || this.isReadOnlyCommand(params);
        this.sendResponse(id, { decision: allow ? 'accept' : 'decline' });
        return;
      }
      case 'item/fileChange/requestApproval': {
        this.sendResponse(id, { decision: relaxed ? 'accept' : 'decline' });
        return;
      }
      case 'item/permissions/requestApproval': {
        this.sendResponse(id, {
          permissions: relaxed && isRecord(params?.permissions) ? params.permissions : {},
          scope: relaxed ? 'session' : 'turn',
        });
        return;
      }
      case 'item/tool/requestUserInput': {
        this.sendResponse(id, { answers: {} });
        return;
      }
      case 'item/tool/call': {
        this.sendResponse(id, {
          success: false,
          contentItems: [
            { type: 'inputText', text: 'Dynamic tool calls are not supported by Kyberion.' },
          ],
        });
        return;
      }
      case 'mcpServer/elicitation/request': {
        this.sendResponse(id, { action: 'decline' });
        return;
      }
      case 'applyPatchApproval': {
        this.sendResponse(id, { decision: relaxed ? 'approved' : 'denied' });
        return;
      }
      case 'execCommandApproval': {
        const allow = relaxed || this.isReadOnlyParsedCommand(params);
        this.sendResponse(id, { decision: allow ? 'approved' : 'denied' });
        return;
      }
      case 'account/chatgptAuthTokens/refresh': {
        this.sendError(id, -32000, 'ChatGPT auth token refresh not supported');
        return;
      }
      default: {
        this.sendError(id, -32601, 'Unsupported request: ' + method);
      }
    }
  }

  private sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T> {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server stdin not writable.');
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.child.stdin.write(payload + '\n');
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error('Codex app-server request timed out (' + method + ').'));
        }, timeoutMs);
      }
      this.pendingRequests.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeout,
      });
    });
  }

  private sendResponse(id: number | string, result: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    this.child.stdin.write(payload + '\n');
  }

  private sendError(id: number | string, code: number, message: string, data?: unknown): void {
    if (!this.child?.stdin?.writable) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } });
    this.child.stdin.write(payload + '\n');
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (!this.child?.stdin?.writable) return;
    try {
      await this.sendRequest(
        'turn/interrupt',
        { threadId, turnId },
        this.options.timeoutMs ?? 20000
      );
    } catch (err) {
      logger.warn(
        '[UAA_CODEX_INTERRUPT] failed to interrupt turn ' +
          turnId +
          ': ' +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  private isReadOnlyCommand(params: unknown): boolean {
    if (!isRecord(params)) return false;
    const actions = Array.isArray(params.commandActions) ? params.commandActions : [];
    if (actions.length === 0) return false;
    const cwd = typeof params.cwd === 'string' ? params.cwd : null;
    if (!this.isCwdAllowed(cwd)) return false;
    return actions.every((action) => {
      if (!isRecord(action)) return false;
      const type = action.type;
      if (type === 'read' || type === 'listFiles' || type === 'search') {
        const targetPath = typeof action.path === 'string' ? action.path : null;
        return this.isPathAllowed(targetPath, cwd);
      }
      return false;
    });
  }

  private isReadOnlyParsedCommand(params: unknown): boolean {
    if (!isRecord(params)) return false;
    const parsed = Array.isArray(params.parsedCmd) ? params.parsedCmd : [];
    if (parsed.length === 0) return false;
    const cwd = typeof params.cwd === 'string' ? params.cwd : null;
    if (!this.isCwdAllowed(cwd)) return false;
    return parsed.every((cmd) => {
      if (!isRecord(cmd)) return false;
      const type = cmd.type;
      const targetPath = typeof cmd.path === 'string' ? cmd.path : null;
      if (type === 'read') return this.isPathAllowed(targetPath, cwd);
      if (type === 'list_files' || type === 'search') {
        return this.isPathAllowed(targetPath, cwd);
      }
      return false;
    });
  }

  private isCwdAllowed(cwd?: string | null): boolean {
    if (!cwd) return true;
    return this.isWithinRoot(cwd);
  }

  private resolveCwd(): string {
    const configured = this.options.cwd || PROJECT_ROOT;
    const resolved = path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(PROJECT_ROOT, configured);
    if (resolved === path.resolve(PROJECT_ROOT)) return resolved;
    return assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
  }

  private isPathAllowed(targetPath?: string | null, cwd?: string | null): boolean {
    if (!targetPath) return true;
    const base = cwd || this.options.cwd || this.projectRoot;
    const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(base, targetPath);
    return this.isWithinRoot(resolved);
  }

  private isWithinRoot(targetPath: string): boolean {
    const root = path.resolve(this.projectRoot);
    const resolved = path.resolve(targetPath);
    if (resolved === root) return true;
    if (!resolved.startsWith(root + path.sep)) return false;
    try {
      assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
      return true;
    } catch {
      return false;
    }
  }
}

export function extractUsageSummary(payload: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (!isRecord(current)) continue;
    const usage = current.usage;
    if (isRecord(usage)) return usage;
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}
