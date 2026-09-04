import { createLogger } from './logger.js';
const logger = createLogger('agent-adapter');
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReaddir,
  safeReadFile,
} from './secure-io.js';
import { spawnManagedProcess, stopManagedProcess, touchManagedProcess } from './managed-process.js';
import { resolveRuntimeModelId } from './runtime-model-defaults.js';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable, PassThrough } from 'node:stream';
import * as path from 'node:path';
import { getRegisteredEnvText, safeChildEnv } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import { resolveActiveProviderPermissionArgs } from './provider-permission-profiles.js';
import { assertReasoningEgressAllowed } from './reasoning-egress-scope.js';
import {
  CodexAppServerAdapter,
  CodexExecutionEnhancer,
  extractUsageSummary,
  type CodexAppServerAdapterOptions,
  type CodexExecutionEnhancerOptions,
  type CodexNativeSubagentInfo,
} from './agent-codex-app-server-adapter.js';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

export {
  CodexAppServerAdapter,
  CodexExecutionEnhancer,
  type CodexAppServerAdapterOptions,
  type CodexExecutionEnhancerOptions,
  type CodexNativeSubagentInfo,
};

const PROJECT_ROOT = pathResolver.rootDir();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SpawnedCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let cliProcessSequence = 0;

/**
 * Keep provider CLI work off the supervisor event loop. A synchronous child
 * process call makes health/status IPC unavailable for the entire provider
 * timeout, which looks like a dead supervisor and can trigger duplicate
 * daemons. The child remains killable on timeout while the daemon keeps
 * serving unrelated requests.
 */
function runCliProcess(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs: number;
    stdio: 'inherit' | ['ignore', 'pipe', 'pipe'];
  }
): Promise<SpawnedCliResult> {
  return new Promise((resolve, reject) => {
    const resourceId = `agent-adapter-cli:${process.pid}:${++cliProcessSequence}`;
    const managed = spawnManagedProcess({
      resourceId,
      kind: 'agent',
      ownerId: resourceId,
      ownerType: 'agent-adapter-cli',
      command,
      args,
      shutdownPolicy: 'manual',
      spawnOptions: {
        env: options.env,
        cwd: options.cwd,
        shell: false,
        stdio: options.stdio,
      },
    });
    const child = managed.child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      stopManagedProcess(resourceId, child);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      cleanup();
      reject(new Error(`provider CLI timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('close', (status) => {
      if (timedOut) return;
      finish(() => resolve({ status, stdout, stderr }));
    });
  });
}

async function getACPSdk() {
  return await import('@agentclientprotocol/sdk');
}

type ACPConnection = InstanceType<typeof import('@agentclientprotocol/sdk').ClientSideConnection>;

/**
 * Universal Agent Adapter (UAA) v1.5
 * Truly Universal: Handles deeply nested ID structures and complex turn lifecycles.
 */

export interface AgentResponse {
  text: string;
  thought?: string;
  stopReason: string;
  trace?: Array<{ enhancer: string; action: string; details?: string }>;
  metadata?: Record<string, unknown>;
}

export interface AgentAskOptions extends Record<string, unknown> {
  phase?: 'onboarding' | 'recovery' | 'alignment' | 'execution' | 'review';
  intentId?: string;
  tags?: string[];
  responseMimeType?: 'text/plain' | 'application/json';
  /** Abort the active provider turn without restarting the app-server process. */
  signal?: AbortSignal;
  /** Ask a provider-native harness to use its subagent mode for this turn. */
  subagent?: boolean;
  /** Native subagent reasoning effort; adopters may map this to provider controls. */
  effort?: 'low' | 'medium' | 'high' | 'ultra';
  /** Per-turn approval projection for a governed provider profile. */
  approvalMode?: 'strict' | 'relaxed';
}

/**
 * Interface for model-specific enhancements (Add-ons).
 */
export interface AgentEnhancer {
  name: string;
  onBeforeAsk?(
    prompt: string,
    options?: AgentAskOptions
  ): Promise<{ prompt: string; options?: AgentAskOptions }>;
  onAfterAsk?(response: AgentResponse): Promise<AgentResponse>;
}

export interface AgentAdapter {
  boot(): Promise<void>;
  ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  shutdown(): Promise<void>;
  getRuntimeInfo?(): Record<string, unknown>;
  refreshContext?(): Promise<{
    mode: 'soft' | 'stateless';
    sessionId?: string | null;
    threadId?: string | null;
  }>;
  addEnhancer?(enhancer: AgentEnhancer): void;
}

function registerEnhancer(enhancers: AgentEnhancer[], enhancer: AgentEnhancer): void {
  enhancers.push(enhancer);
  logger.info(`[UAA] Enhancer added: ${enhancer.name}`);
}

function summarizePromptForLog(prompt: string, maxChars = 200): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars)}...`;
}

async function waitForBootSignal(
  child: ChildProcess,
  label: string,
  timeoutMs = Number(getRegisteredEnvText('KYBERION_AGENT_BOOT_READY_TIMEOUT_MS') || 5000)
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      child.off('spawn', done);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      if (timer) clearTimeout(timer);
    };
    const onData = (): void => done();
    const timer = setTimeout(() => {
      logger.warn(`[UAA] Boot ready signal timeout for ${label}; continuing after ${timeoutMs}ms`);
      done();
    }, timeoutMs);
    timer.unref?.();
    child.once('spawn', done);
    child.stdout?.once('data', onData);
    child.stderr?.once('data', onData);
  });
}

function isSafeReadOnlyPermissionTitle(title: string): boolean {
  const normalized = title.toLowerCase();
  const allowPatterns = [
    /\bread\b/,
    /\bsearch\b/,
    /\blist\b/,
    /\bview\b/,
    /\binspect\b/,
    /\bfetch\b/,
  ];
  const denyPatterns = [
    /\bwrite\b/,
    /\bedit\b/,
    /\bdelete\b/,
    /\bremove\b/,
    /\bcreate\b/,
    /\bexecute\b/,
    /\brun\b/,
    /\bapply\b/,
    /\bpatch\b/,
  ];
  if (denyPatterns.some((pattern) => pattern.test(normalized))) return false;
  return allowPatterns.some((pattern) => pattern.test(normalized));
}

function isNativeSubagentToolCall(toolCall: unknown): boolean {
  if (!isRecord(toolCall)) return false;
  return [toolCall.name, toolCall.title, toolCall.toolName, toolCall.tool_name]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => /(?:^|[_:.-])spawn[_:.-]?subagent(?:$|[_:.-])/i.test(value));
}

function firstStringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
}

function extractAcpSessionId(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const thread = isRecord(response.thread) ? response.thread : undefined;
  return firstStringValue(response.sessionId, response.threadId, thread?.id);
}

function parseProviderJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parseSafeJsonInput(raw, 'provider JSON response');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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
        details: `Diff: ${currentPrompt.length - originalPrompt.length} chars`,
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

interface ACPDialect {
  authenticate: string;
  newSession: string;
  prompt: string;
}

abstract class BaseACPAdapter implements AgentAdapter {
  protected child: ChildProcess | null = null;
  protected connection: ACPConnection | null = null;
  protected acpSessionId: string | null = null;
  protected accumulatedResponse: string = '';
  protected accumulatedThought: string = '';
  protected runtimeResourceId: string | null = null;
  protected usageSummary: Record<string, unknown> | null = null;
  protected enhancers: AgentEnhancer[] = [];

  constructor(
    protected bootCommand: string,
    protected bootArgs: string[],
    protected dialect: ACPDialect,
    protected authMethod: string = 'oauth-personal'
  ) {}

  protected async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const title = (params.toolCall?.title || '').toLowerCase();
    if (isSafeReadOnlyPermissionTitle(title)) {
      const optionId = params.options?.[0]?.optionId;
      return optionId
        ? { outcome: { outcome: 'selected' as const, optionId } }
        : { outcome: { outcome: 'cancelled' as const } };
    }
    logger.warn(`[UAA_PERMISSION] Auto-denied non-read operation: ${params.toolCall?.title}`);
    return { outcome: { outcome: 'cancelled' as const } };
  }

  public addEnhancer(enhancer: AgentEnhancer): void {
    registerEnhancer(this.enhancers, enhancer);
  }

  protected handleSessionUpdate(_params: SessionNotification): void {}

  public async boot(): Promise<void> {
    logger.info(`[UAA] Spawning: ${this.bootCommand} ${this.bootArgs.join(' ')}`);
    this.runtimeResourceId = `adapter:${this.bootCommand}`;
    const managed = spawnManagedProcess({
      resourceId: this.runtimeResourceId,
      kind: 'agent',
      ownerId: this.bootCommand,
      ownerType: 'agent-adapter',
      command: this.bootCommand,
      args: this.bootArgs,
      shutdownPolicy: 'manual',
      spawnOptions: {
        cwd: PROJECT_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeChildEnv() as NodeJS.ProcessEnv,
      },
      metadata: {
        bootCommand: this.bootCommand,
        bootArgs: this.bootArgs,
      },
    });
    this.child = managed.child;
    this.child.stdin?.on('error', (error) => {
      logger.warn(
        `[UAA] Provider stdio input closed: ${error instanceof Error ? error.message : error}`
      );
    });

    const sdkInput = new PassThrough();
    const sdkOutput = new PassThrough();
    let guestBuffer = '';

    this.child.stdout?.on('data', (chunk) => {
      guestBuffer += chunk.toString();
      const lines = guestBuffer.split('\n');
      guestBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          sdkInput.write(trimmed + '\n');
          if (this.runtimeResourceId) {
            touchManagedProcess(this.runtimeResourceId);
          }
        }
      }
    });

    sdkOutput.on('data', (data) => {
      const msg = data.toString();
      if (this.child?.stdin?.writable) this.child.stdin.write(msg);
      if (this.runtimeResourceId) {
        touchManagedProcess(this.runtimeResourceId);
      }
    });

    const { ClientSideConnection, ndJsonStream } = await getACPSdk();
    this.connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          logger.info(`[UAA_NOTIF] ${JSON.stringify(params)}`);
          this.handleSessionUpdate(params);

          // RECURSIVE SCAN for text/thought chunks
          const findContent = (value: unknown): void => {
            if (Array.isArray(value)) {
              for (const item of value) findContent(item);
              return;
            }
            if (!isRecord(value)) return;
            const content = isRecord(value.content) ? value.content : undefined;

            // Look for Gemini-style update
            if (
              value.sessionUpdate === 'agent_message_chunk' &&
              typeof content?.text === 'string'
            ) {
              this.accumulatedResponse += content.text;
            } else if (
              value.sessionUpdate === 'agent_thought_chunk' &&
              typeof content?.text === 'string'
            ) {
              this.accumulatedThought += content.text;
            }

            // Look for Codex-style turn update
            const turn = isRecord(value.turn) ? value.turn : undefined;
            if (Array.isArray(turn?.items)) {
              for (const item of turn.items) {
                if (isRecord(item) && item.type === 'message' && typeof item.text === 'string') {
                  // Only add if not already present (simplified deduplication)
                  if (!this.accumulatedResponse.includes(item.text)) {
                    this.accumulatedResponse += item.text;
                  }
                }
              }
            }

            // Recurse into objects/arrays
            for (const nested of Object.values(value)) findContent(nested);
          };

          findContent(params);
        },
        requestPermission: (params) => this.requestPermission(params),
        async readTextFile(params) {
          throw new Error('Not implemented');
        },
        async writeTextFile(params) {
          throw new Error('Not implemented');
        },
        async createTerminal(params) {
          throw new Error('Not implemented');
        },
        extMethod: async (m, p) => ({}),
        extNotification: async (m, p) => {},
      }),
      ndJsonStream(
        Writable.toWeb(sdkOutput) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(sdkInput) as unknown as ReadableStream<Uint8Array>
      )
    );

    await waitForBootSignal(this.child, `agent-adapter:${this.bootCommand}`);
    await this.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'Kyberion', version: '1.0.0' },
    });

    try {
      await this.connection.extMethod(this.dialect.authenticate, {
        methodId: this.authMethod,
        type: this.authMethod,
      });
    } catch (err) {
      logger.warn(`suppressed error in createTerminal: ${err}`);
    }

    const sessionRes = await this.connection.extMethod(this.dialect.newSession, {
      cwd: PROJECT_ROOT,
      workingDirectory: PROJECT_ROOT,
      mcpServers: [],
    });

    // ROBUST ID EXTRACTION: Check all known locations
    this.acpSessionId = extractAcpSessionId(sessionRes) ?? null;

    if (!this.acpSessionId) {
      throw new Error(`Failed to extract session ID from response: ${JSON.stringify(sessionRes)}`);
    }
    logger.info(`[UAA] Ready. ID: ${this.acpSessionId}`);

    // Gemini often needs a specific model via set_model if default is busy
    try {
      await this.connection.extMethod('session/set_model', {
        sessionId: this.acpSessionId,
        modelId: resolveRuntimeModelId('gemini-default'),
      });
    } catch (err) {
      logger.warn(`suppressed error in createTerminal: ${err}`);
    }
  }

  public async ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse> {
    if (!this.connection || !this.acpSessionId) throw new Error('Agent not booted.');

    const trace: Array<{ enhancer: string; action: string; details?: string }> = [];
    const enhanced = await applyEnhancersBeforeAsk(this.enhancers, prompt, options || {}, trace);

    this.accumulatedResponse = '';
    this.accumulatedThought = '';

    const response = await this.connection.extMethod(this.dialect.prompt, {
      sessionId: this.acpSessionId,
      threadId: this.acpSessionId,
      prompt: [{ type: 'text', text: enhanced.prompt }],
      content: [{ type: 'text', text: enhanced.prompt }],
      input: [{ type: 'text', text: enhanced.prompt }],
      ...enhanced.options,
    });
    this.usageSummary = extractUsageSummary(response);

    logger.info(`[UAA_RESULT] ${JSON.stringify(response)}`); // DEBUG: Watch response structure

    // If accumulatedResponse is empty, try to extract from the result object
    let finalText = this.accumulatedResponse;
    const turn = isRecord(response.turn) ? response.turn : undefined;
    if (!finalText && Array.isArray(turn?.content)) {
      finalText = turn.content
        .filter(
          (part): part is Record<string, unknown> =>
            isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        )
        .map((part) => part.text)
        .join('\n');
    }

    const agentResponse: AgentResponse = {
      text: finalText,
      thought: this.accumulatedThought,
      stopReason: firstStringValue(response.stopReason) || 'completed',
      trace,
    };
    return applyEnhancersAfterAsk(this.enhancers, agentResponse);
  }

  public async shutdown(): Promise<void> {
    if (this.child) {
      if (this.runtimeResourceId) {
        stopManagedProcess(this.runtimeResourceId, this.child);
      }
      this.child = null;
    }
    this.runtimeResourceId = null;
  }

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      pid: this.child?.pid,
      sessionId: this.acpSessionId,
      usage: this.usageSummary,
      supportsSoftRefresh: true,
    };
  }

  public async refreshContext(): Promise<{ mode: 'soft'; sessionId?: string | null }> {
    if (!this.connection) throw new Error('Agent not booted.');
    const sessionRes = await this.connection.extMethod(this.dialect.newSession, {
      cwd: PROJECT_ROOT,
      workingDirectory: PROJECT_ROOT,
      mcpServers: [],
    });
    this.acpSessionId = extractAcpSessionId(sessionRes) ?? null;
    return { mode: 'soft', sessionId: this.acpSessionId };
  }
}

export interface GeminiAdapterOptions {
  model?: string;
}

export class GeminiAdapter extends BaseACPAdapter {
  private options: GeminiAdapterOptions;

  constructor(options?: GeminiAdapterOptions) {
    super(
      'gemini',
      ['--acp'],
      {
        authenticate: 'authenticate',
        newSession: 'session/new',
        prompt: 'session/prompt',
      },
      'oauth-personal'
    );
    this.options = options || {};

    // Auto-apply Gemini Add-ons for Pro models
    if (this.options.model?.includes('pro') || !this.options.model) {
      this.addEnhancer(new GeminiPhaseAwareInstructionEnhancer());
      this.addEnhancer(new GeminiWisdomEnhancer());
      this.addEnhancer(new GeminiJsonModeEnforcer());
    }
  }

  public async boot(): Promise<void> {
    await super.boot();
    const targetModel = this.options.model || resolveRuntimeModelId('gemini-default');
    try {
      await this.connection?.extMethod('session/set_model', {
        sessionId: this.acpSessionId,
        modelId: targetModel,
      });
    } catch (err) {
      logger.warn(`suppressed error in boot: ${err}`);
    }
  }
}

export interface GrokAdapterOptions {
  bin?: string;
  model?: string;
  leaderSocket?: string;
}

/**
 * Grok Build ACP adapter. One long-lived `grok agent stdio` process owns the
 * parent session; native delegation asks that session to use Grok's native
 * `spawn_subagent` capability without creating another provider process.
 */
export class GrokAdapter extends BaseACPAdapter {
  private readonly model?: string;
  private activePermissionMode: 'read-only' | 'workspace-write' = 'read-only';
  private lastNativeSubagentInfo: Record<string, unknown> | null = null;

  constructor(options: GrokAdapterOptions = {}) {
    super(
      options.bin ?? 'grok',
      [
        'agent',
        'stdio',
        ...(options.leaderSocket ? ['--leader-socket', options.leaderSocket] : []),
      ],
      {
        authenticate: 'authenticate',
        newSession: 'session/new',
        prompt: 'session/prompt',
      },
      'oauth-personal'
    );
    this.model = options.model;
  }

  public async boot(): Promise<void> {
    await super.boot();
    if (this.model) {
      try {
        await this.connection?.extMethod('session/set_model', {
          sessionId: this.acpSessionId,
          modelId: this.model,
        });
      } catch (err) {
        logger.warn(`[UAA] Grok model selection was not accepted: ${err}`);
      }
    }
  }

  protected async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    if (this.activePermissionMode === 'workspace-write') {
      const option = params.options.find((candidate) =>
        ['allow_once', 'allow_always'].includes(candidate.kind || candidate.optionId)
      );
      if (option?.optionId) {
        return { outcome: { outcome: 'selected' as const, optionId: option.optionId } };
      }
    }
    return super.requestPermission(params);
  }

  private nativeSubagentObserved = false;
  private nativeSubagentCompleted = false;
  private nativeSubagentChildId: string | undefined;

  protected handleSessionUpdate(params: SessionNotification): void {
    const envelope = params as unknown as Record<string, unknown>;
    const update = isRecord(envelope.update) ? envelope.update : envelope;
    const toolCall = isRecord(envelope.toolCall) ? envelope.toolCall : undefined;
    const updateToolCall = isRecord(update.toolCall) ? update.toolCall : undefined;
    if (
      isNativeSubagentToolCall(toolCall) ||
      isNativeSubagentToolCall(updateToolCall) ||
      isNativeSubagentToolCall(update.tool_call)
    ) {
      this.nativeSubagentObserved = true;
      this.nativeSubagentChildId =
        firstStringValue(
          envelope.subagentId,
          envelope.subagent_id,
          envelope.childSessionId,
          envelope.child_session_id,
          toolCall?.subagentId,
          toolCall?.subagent_id,
          update.subagentId,
          update.subagent_id,
          update.childSessionId,
          update.child_session_id,
          update.threadId,
          update.thread_id
        ) ?? this.nativeSubagentChildId;
    }

    // The available-commands notification advertises `spawn_subagent` in a
    // tools list; it is not evidence that the model invoked it. Only inspect
    // protocol updates whose kind represents an actual tool/subagent event.
    const meta = isRecord(envelope._meta) ? envelope._meta : undefined;
    const updateKind = String(update.sessionUpdate ?? meta?.updateType ?? '');
    if (!/(tool|subagent)/i.test(updateKind)) return;
    const serialized = JSON.stringify(update);
    if (/spawn[_-]?subagent/i.test(serialized)) {
      this.nativeSubagentObserved = true;
    }
    if (
      /(?:subagent|spawn[_-]?subagent).*(?:completed|complete|finished|result|returned)|(?:completed|complete|finished|result|returned).*(?:subagent|spawn[_-]?subagent)/i.test(
        serialized
      )
    ) {
      this.nativeSubagentCompleted = true;
      this.nativeSubagentChildId =
        firstStringValue(
          envelope.subagentId,
          envelope.subagent_id,
          envelope.childSessionId,
          envelope.child_session_id,
          toolCall?.subagentId,
          toolCall?.subagent_id,
          update.subagentId,
          update.subagent_id,
          update.childSessionId,
          update.child_session_id,
          update.threadId,
          update.thread_id
        ) ?? this.nativeSubagentChildId;
    }
  }

  public async askNativeSubagent(
    prompt: string,
    options: AgentAskOptions = {}
  ): Promise<AgentResponse> {
    if (process.env.GROK_SUBAGENTS === '0') {
      throw new Error(
        '[SUBAGENT_UNAVAILABLE] Grok native subagents are disabled by GROK_SUBAGENTS=0.'
      );
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('[SUBAGENT_UNAVAILABLE] Grok ACP session is not booted.');
    }

    const parentSessionId = this.acpSessionId;
    const previousPermissionMode = this.activePermissionMode;
    this.nativeSubagentObserved = false;
    this.nativeSubagentCompleted = false;
    this.nativeSubagentChildId = undefined;
    this.activePermissionMode = options.profile === 'implementer' ? 'workspace-write' : 'read-only';
    try {
      const response = await super.ask(
        [
          'Use the provider-native spawn_subagent capability exactly once for this bounded task.',
          'Do not solve the task in the parent session; return the delegated task result only after the subagent completes.',
          prompt,
        ].join('\n\n'),
        { ...options, subagent: true }
      );
      if (!this.nativeSubagentObserved || !this.nativeSubagentCompleted) {
        throw new Error(
          '[SUBAGENT_UNAVAILABLE] Grok did not provide both native spawn_subagent invocation and completion evidence.'
        );
      }
      this.lastNativeSubagentInfo = {
        provider: 'grok',
        parentThreadId: parentSessionId,
        mode: 'acp-native-subagent',
        effort: options.effort ?? 'medium',
        proof: 'spawn_subagent_invoked_and_completed',
        ...(this.nativeSubagentChildId ? { threadId: this.nativeSubagentChildId } : {}),
      };
      return {
        ...response,
        metadata: {
          ...(response.metadata || {}),
          nativeSubagent: this.lastNativeSubagentInfo,
        },
      };
    } finally {
      this.activePermissionMode = previousPermissionMode;
    }
  }

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      ...super.getRuntimeInfo(),
      supportsNativeSubagents: process.env.GROK_SUBAGENTS !== '0',
      lastNativeSubagent: this.lastNativeSubagentInfo,
    };
  }
}

/**
 * Gemini-specific Add-on: Adjusts system behavior based on mission phase.
 */
export class GeminiPhaseAwareInstructionEnhancer implements AgentEnhancer {
  public name = 'GeminiPhaseAwareInstructionEnhancer';

  public async onBeforeAsk(
    prompt: string,
    options?: AgentAskOptions
  ): Promise<{ prompt: string; options?: AgentAskOptions }> {
    if (!options?.phase) return { prompt, options };

    const phaseInstructions: Record<string, string> = {
      alignment:
        'Focus on understanding intent, clarifying ambiguity, and defining clear success criteria.',
      execution:
        'Prioritize surgical, deterministic code changes. Follow AGENTS.md strictly. Test before finality.',
      review:
        'Critically analyze changes for regressions, security leaks, and architectural consistency.',
    };

    const instruction = phaseInstructions[options.phase];
    if (instruction) {
      const enhancedPrompt = `
<phase_directive phase="${options.phase}">
${instruction}
</phase_directive>

${prompt}`;
      return { prompt: enhancedPrompt, options };
    }

    return { prompt, options };
  }
}

/**
 * Gemini-specific Add-on: Enforces JSON mode for structured tasks.
 */
export class GeminiJsonModeEnforcer implements AgentEnhancer {
  public name = 'GeminiJsonModeEnforcer';

  public async onBeforeAsk(
    prompt: string,
    options?: AgentAskOptions
  ): Promise<{ prompt: string; options?: AgentAskOptions }> {
    // If the task implies structured output (ADF, manifest, etc.), ensure JSON mode
    const structuredTriggers = [/\badf\b/i, /\bmanifest\b/i, /\bschema\b/i, /\bjson\b/i];
    const isStructured =
      structuredTriggers.some((t) => t.test(prompt)) ||
      options?.responseMimeType === 'application/json';

    if (isStructured) {
      const enhancedOptions = {
        ...options,
        responseMimeType: 'application/json' as const,
      };
      const enhancedPrompt = `${prompt}\n\nIMPORTANT: Return valid JSON ONLY. No markdown wrappers.`;
      return { prompt: enhancedPrompt, options: enhancedOptions };
    }

    return { prompt, options };
  }
}

/**
 * Gemini-specific Add-on: Loads "Wisdom" from the evolution history
 * to leverage Gemini's large context window for self-improvement.
 */
export class GeminiWisdomEnhancer implements AgentEnhancer {
  public name = 'GeminiWisdomEnhancer';

  public async onBeforeAsk(
    prompt: string,
    options?: AgentAskOptions
  ): Promise<{ prompt: string; options?: AgentAskOptions }> {
    const wisdomDir = assertSafeRepositoryPath(
      path.join(PROJECT_ROOT, 'knowledge/product/evolution'),
      { allowMissingLeaf: true }
    );
    let wisdomContext = '';

    try {
      if (safeExistsSync(wisdomDir)) {
        const files = safeReaddir(wisdomDir);
        // Keep deterministic lesson order to avoid response drift between runs.
        const mdFiles = files
          .filter((f) => f.endsWith('.md'))
          .sort((a, b) => a.localeCompare(b))
          .slice(-5);

        for (const file of mdFiles) {
          const wisdomFile = assertSafeRepositoryPath(path.join(wisdomDir, file));
          const content = safeReadFile(wisdomFile, { encoding: 'utf8' }) as string;
          wisdomContext += `\n--- Lesson from ${file} ---\n${content}\n`;
        }
      }
    } catch (e) {
      logger.warn(`[GeminiEnhancer] Failed to load wisdom: ${e}`);
    }

    if (wisdomContext) {
      const enhancedPrompt = `
<wisdom_context>
The following are lessons learned from previous evolutions and missions. 
Use these to avoid past mistakes and align with the ecosystem standards:
${wisdomContext}
</wisdom_context>

User Request:
${prompt}`;

      return { prompt: enhancedPrompt, options };
    }

    return { prompt, options };
  }
}

export type BuiltinAgentProvider = 'gemini' | 'codex' | 'claude' | 'agy' | 'grok';
export class CodexAdapter implements AgentAdapter {
  protected enhancers: AgentEnhancer[] = [];

  constructor() {
    this.addEnhancer(new CodexExecutionEnhancer());
  }

  public addEnhancer(enhancer: AgentEnhancer): void {
    registerEnhancer(this.enhancers, enhancer);
  }

  public async boot(): Promise<void> {
    logger.info('[UAA] Codex (Exec mode) ready.');
  }

  public async ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse> {
    const trace: Array<{ enhancer: string; action: string; details?: string }> = [];
    const enhanced = await applyEnhancersBeforeAsk(this.enhancers, prompt, options, trace);
    logger.info(`[UAA] Codex Executing prompt: "${summarizePromptForLog(enhanced.prompt)}"`);
    assertReasoningEgressAllowed('codex-cli');

    try {
      // Pass the text as a single argument to npx/codex exec
      const activePermissionArgs = resolveActiveProviderPermissionArgs('codex') ?? [];
      const res = await runCliProcess(
        'npx',
        ['codex', 'exec', ...activePermissionArgs, '--json', enhanced.prompt],
        {
          env: safeChildEnv() as NodeJS.ProcessEnv,
          cwd: PROJECT_ROOT,
          timeoutMs: 300000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      if (res.status !== 0) {
        logger.error(`[UAA] Codex Exit Code: ${res.status}`);
        logger.error(`[UAA] Codex Stderr: ${res.stderr}`);
        return { text: '', stopReason: 'error', trace };
      }

      const parsed = parseProviderJsonObject(res.stdout);
      if (!parsed) throw new Error('Codex returned a non-object JSON response');
      const agentResponse: AgentResponse = {
        text: firstStringValue(parsed.message, parsed.content) || res.stdout,
        ...(typeof parsed.thought === 'string' ? { thought: parsed.thought } : {}),
        stopReason: 'completed',
        trace,
      };
      return applyEnhancersAfterAsk(this.enhancers, agentResponse);
    } catch (e: unknown) {
      logger.error(`[UAA] Codex Exec failed: ${errorMessage(e)}`);
      return { text: '', stopReason: 'error', trace };
    }
  }

  public async shutdown(): Promise<void> {}

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      supportsSoftRefresh: false,
      stateless: true,
    };
  }

  public async refreshContext(): Promise<{ mode: 'stateless' }> {
    return { mode: 'stateless' };
  }
}

export interface AgyAdapterOptions {
  bin?: string;
  cwd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  model?: string;
}

export class AgyAdapter implements AgentAdapter {
  private options: AgyAdapterOptions;
  private logBuffer: { ts: number; type: string; content: string }[] = [];
  private usageSummary: Record<string, unknown> | null = null;
  private activeSessionId: string | null = null;

  constructor(options?: AgyAdapterOptions) {
    this.options = options || {};
  }

  public getLog(limit = 50): { ts: number; type: string; content: string }[] {
    return this.logBuffer.slice(-limit);
  }

  public async boot(): Promise<void> {
    logger.info(`[UAA] Agy CLI ready (bin: ${this.options.bin || 'agy'})`);
  }

  public async ask(text: string, options?: AgentAskOptions): Promise<AgentResponse> {
    const isInteractive = options?.interactive === true;
    logger.info(
      `[UAA] Agy asking (${isInteractive ? 'interactive' : 'non-interactive'}): "${text.slice(0, 80)}..."`
    );
    this.logBuffer.push({ ts: Date.now(), type: 'prompt', content: text });
    assertReasoningEgressAllowed('agy-cli');

    try {
      const bin =
        this.options.bin ||
        getRegisteredEnvText('KYBERION_ANTIGRAVITY_CLI_BIN') ||
        getRegisteredEnvText('KYBERION_AGY_CLI_BIN') ||
        'agy';

      const args: string[] = [];
      if (isInteractive) {
        args.push('-i');
      } else {
        args.push('-p');
      }

      args.push(text);
      const activePermissionArgs = resolveActiveProviderPermissionArgs('agy');
      if (activePermissionArgs) {
        args.push(...activePermissionArgs);
      } else {
        args.push('--dangerously-skip-permissions');
      }

      // 1. Session Persistence & Continuity
      const session = (options?.conversationId as string | undefined) || options?.intentId;
      if (session) {
        args.push('--conversation', session);
        this.activeSessionId = session;
      }

      // 2. Dynamic Context Directories mounting
      const addDirs = options?.addDirs as string[] | undefined;
      if (addDirs && Array.isArray(addDirs)) {
        for (const dir of addDirs) {
          args.push('--add-dir', dir);
        }
      }

      // 3. Sandboxed Execution
      const useSandbox =
        options?.sandbox === true || getRegisteredEnvText('KYBERION_AGY_SANDBOX') === '1';
      if (useSandbox) {
        args.push('--sandbox');
      }

      if (this.options.model) {
        args.push('--model', this.options.model);
      }

      if (this.options.extraArgs) {
        args.push(...this.options.extraArgs);
      }

      const res = await runCliProcess(bin, args, {
        env: safeChildEnv() as NodeJS.ProcessEnv,
        cwd: this.options.cwd || PROJECT_ROOT,
        timeoutMs: this.options.timeoutMs || 300000,
        stdio: isInteractive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });

      if (isInteractive) {
        return {
          text: 'Interactive session completed.',
          stopReason: 'completed',
        };
      }

      const output = (res.stdout || '').trim();
      if (res.stderr)
        this.logBuffer.push({ ts: Date.now(), type: 'stderr', content: res.stderr.trim() });
      this.logBuffer.push({ ts: Date.now(), type: 'agent', content: output.slice(0, 500) });
      if (this.logBuffer.length > 200) this.logBuffer = this.logBuffer.slice(-200);

      // Agy response extraction (if output starts with JSON or has ```json wrapper)
      const lines = output.split('\n');
      const jsonStartIdx = lines.findIndex((l) => l.trim().startsWith('{'));
      if (jsonStartIdx !== -1) {
        const cleanStdout = lines.slice(jsonStartIdx).join('\n');
        try {
          const cliResult = parseProviderJsonObject(cleanStdout);
          if (!cliResult) throw new Error('Agy returned a non-object JSON response');
          this.usageSummary = extractUsageSummary(cliResult);
          return {
            text: (firstStringValue(cliResult.response) || output).trim(),
            ...(typeof cliResult.thought === 'string' ? { thought: cliResult.thought } : {}),
            stopReason: res.status === 0 ? 'completed' : 'error',
          };
        } catch (_) {
          // ignore parsing error and fallback
        }
      }

      return {
        text: output,
        stopReason: res.status === 0 ? 'completed' : 'error',
      };
    } catch (e: unknown) {
      logger.error(`[UAA] Agy failed: ${errorMessage(e)}`);
      return { text: '', stopReason: 'error' };
    }
  }

  public async shutdown(): Promise<void> {}

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      usage: this.usageSummary,
      supportsSoftRefresh: true,
      stateless: this.activeSessionId ? false : true,
      sessionId: this.activeSessionId,
    };
  }

  public async refreshContext(): Promise<{ mode: 'soft' | 'stateless'; sessionId: string | null }> {
    if (this.activeSessionId) {
      return { mode: 'soft', sessionId: this.activeSessionId };
    }
    return { mode: 'stateless', sessionId: null };
  }
}

/**
 * Claude Code Adapter using stream-json mode for rich communication.
 *
 * Leverages Claude Code CLI features:
 * - --output-format stream-json: NDJSON streaming responses
 * - --system-prompt: Direct system prompt injection
 * - --allowedTools / --disallowedTools: Native tool restriction
 * - --model: Model selection (sonnet, opus, haiku)
 * - --max-budget-usd: Cost control
 * - --session-id: Session persistence
 */
export interface ClaudeAdapterOptions {
  systemPrompt?: string;
  cwd?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  allowedTools?: string[];
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  sessionId?: string;
  permissionMode?: 'default' | 'plan' | 'auto' | 'bypassPermissions';
}

// Map Kyberion actuator names to Claude Code tool names
const ACTUATOR_TO_CLAUDE_TOOLS: Record<string, string[]> = {
  'file-actuator': ['Read', 'Write', 'Edit', 'Glob'],
  'system-actuator': ['Bash'],
  'browser-actuator': ['WebFetch', 'WebSearch'],
  'code-actuator': ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
  'network-actuator': ['WebFetch', 'WebSearch'],
};

export class ClaudeAdapter implements AgentAdapter {
  private options: ClaudeAdapterOptions;
  private logBuffer: { ts: number; type: string; content: string }[] = [];
  private usageSummary: Record<string, unknown> | null = null;

  constructor(options?: ClaudeAdapterOptions) {
    this.options = options || {};
  }

  public getLog(limit = 50): { ts: number; type: string; content: string }[] {
    return this.logBuffer.slice(-limit);
  }

  public async boot(): Promise<void> {
    logger.info(
      `[UAA] Claude Code ready (model: ${this.options.model || 'default'}, session: ${this.options.sessionId || 'new'})`
    );
  }

  public async ask(text: string): Promise<AgentResponse> {
    logger.info(`[UAA] Claude asking: "${text.slice(0, 80)}..."`);
    this.logBuffer.push({ ts: Date.now(), type: 'prompt', content: text });
    assertReasoningEgressAllowed('claude-cli');
    try {
      const args = ['-p', text, '--output-format', 'json'];

      if (this.options.systemPrompt) {
        args.push('--system-prompt', this.options.systemPrompt);
      }
      if (this.options.model) {
        args.push('--model', this.options.model);
      }
      if (this.options.effort) {
        args.push('--effort', this.options.effort);
      }
      if (this.options.maxBudgetUsd) {
        args.push('--max-budget-usd', String(this.options.maxBudgetUsd));
      }
      if (this.options.sessionId) {
        args.push('--session-id', this.options.sessionId);
      }
      const activePermissionArgs = resolveActiveProviderPermissionArgs('claude');
      if (activePermissionArgs) {
        args.push(...activePermissionArgs);
      } else if (this.options.permissionMode) {
        args.push('--permission-mode', this.options.permissionMode);
      }

      // Tool restrictions from manifest
      if (
        !activePermissionArgs &&
        this.options.allowedTools &&
        this.options.allowedTools.length > 0
      ) {
        // Claude CLI separates tool availability (--tools) from automatic
        // permission approval (--allowedTools). Supplying only the latter
        // can leave print-mode workers with no executable tools at all.
        args.push('--tools', this.options.allowedTools.join(','));
        args.push('--allowedTools', ...this.options.allowedTools);
      }
      if (
        !activePermissionArgs &&
        this.options.disallowedTools &&
        this.options.disallowedTools.length > 0
      ) {
        args.push('--disallowedTools', ...this.options.disallowedTools);
      }

      const result = await runCliProcess('claude', args, {
        env: safeChildEnv() as NodeJS.ProcessEnv,
        cwd: this.options.cwd || PROJECT_ROOT,
        timeoutMs: 300000, // 5 min for complex tasks
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const output = result.stdout.trim();
      if (result.stderr)
        this.logBuffer.push({ ts: Date.now(), type: 'stderr', content: result.stderr.trim() });
      this.logBuffer.push({ ts: Date.now(), type: 'agent', content: output.slice(0, 500) });
      if (this.logBuffer.length > 200) this.logBuffer = this.logBuffer.slice(-200);
      try {
        const parsed = parseProviderJsonObject(output);
        if (!parsed) throw new Error('Claude returned a non-object JSON response');
        this.usageSummary = extractUsageSummary(parsed);
        return {
          text: firstStringValue(parsed.result, parsed.content, parsed.message) || output,
          ...(typeof parsed.thought === 'string' ? { thought: parsed.thought } : {}),
          stopReason: result.status === 0 ? 'completed' : 'error',
        };
      } catch (_) {
        // Fallback: treat as plain text
        return {
          text: output || result.stderr || '',
          stopReason: result.status === 0 ? 'completed' : 'error',
        };
      }
    } catch (e: unknown) {
      logger.error(`[UAA] Claude failed: ${errorMessage(e)}`);
      return { text: '', stopReason: 'error' };
    }
  }

  public async shutdown(): Promise<void> {}

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      sessionId: this.options.sessionId || null,
      usage: this.usageSummary,
      supportsSoftRefresh: false,
      stateless: !this.options.sessionId,
    };
  }

  /**
   * Convert Kyberion actuator restrictions to Claude Code tool names.
   */
  static resolveToolRestrictions(
    allowedActuators: string[],
    deniedActuators: string[]
  ): { allowedTools: string[]; disallowedTools: string[] } {
    const allowedTools: Set<string> = new Set();
    const disallowedTools: Set<string> = new Set();

    if (allowedActuators.length > 0) {
      for (const actuator of allowedActuators) {
        const tools = ACTUATOR_TO_CLAUDE_TOOLS[actuator];
        if (tools) tools.forEach((t) => allowedTools.add(t));
      }
    }

    for (const actuator of deniedActuators) {
      const tools = ACTUATOR_TO_CLAUDE_TOOLS[actuator];
      if (tools) {
        for (const tool of tools) {
          // Several Kyberion actuators intentionally share a Claude tool
          // (for example code-actuator and system-actuator both map to
          // Bash). An explicitly allowed, more specific actuator must not be
          // erased merely because a broader actuator is denied.
          if (!allowedTools.has(tool)) disallowedTools.add(tool);
        }
      }
    }

    return {
      allowedTools: allowedTools.size > 0 ? Array.from(allowedTools) : [],
      disallowedTools: Array.from(disallowedTools),
    };
  }
}

export class AgentFactory {
  public static create(provider: BuiltinAgentProvider): AgentAdapter {
    const factory = AGENT_ADAPTER_FACTORIES[provider];
    if (!factory) {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    return factory();
  }
}

type AgentAdapterFactory = () => AgentAdapter;

function createCodexAdapterFromEnv(): AgentAdapter {
  const mode = (getRegisteredEnvText('KYBERION_CODEX_MODE') || 'app-server').toLowerCase();
  if (mode === 'exec' || mode === 'legacy') return new CodexAdapter();
  return new CodexAppServerAdapter({
    model: getRegisteredEnvText('KYBERION_CODEX_MODEL'),
    modelProvider: getRegisteredEnvText('KYBERION_CODEX_MODEL_PROVIDER'),
    approvalMode:
      (getRegisteredEnvText('KYBERION_CODEX_APPROVAL') || 'strict').toLowerCase() === 'relaxed'
        ? 'relaxed'
        : 'strict',
  });
}

const AGENT_ADAPTER_FACTORIES: Record<BuiltinAgentProvider, AgentAdapterFactory> = {
  gemini: () => new GeminiAdapter(),
  codex: () => createCodexAdapterFromEnv(),
  claude: () => new ClaudeAdapter(),
  agy: () => new AgyAdapter(),
  grok: () => new GrokAdapter(),
};
