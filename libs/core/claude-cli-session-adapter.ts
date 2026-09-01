/* eslint-disable no-restricted-imports -- the provider boundary owns this managed CLI session process. */
/**
 * Claude CLI session adapter (CN-01) — the concrete native-subagent surface
 * for the local `claude` CLI.
 *
 * One long-lived `claude -p --input-format stream-json --output-format
 * stream-json` process serves every delegation for a given (model, tier,
 * effort) signature, and each delegated task runs as a *provider-native*
 * sub-agent inside it. This is the Claude counterpart of
 * `CodexAppServerAdapter` (shared app-server) and `AgySdkAdapter` (shared SDK
 * bridge): the provider protocol lives entirely behind this boundary, and
 * `ShellClaudeCliBackend` only exposes it through `NativeSubagentAdopter`.
 *
 * Fail-closed contract: a turn only counts as native delegation when the
 * stream actually proves one happened — a `Agent`/`Task` tool_use carrying a
 * `subagent_type`, plus at least one message scoped to that tool_use id.
 * Without that proof the adapter returns no `nativeSubagent` metadata and
 * the backend raises `[SUBAGENT_UNAVAILABLE]` rather than presenting an
 * ordinary single-agent turn as a sub-agent delegation.
 *
 * Protocol notes (Claude Code CLI 2.1.x, observed):
 *  - nothing is emitted until the first user message; `system/init` then
 *    reports `session_id`, the registered `agents`, and the parent `tools`;
 *  - `--output-format stream-json` requires `--verbose`;
 *  - `--setting-sources ''` keeps the agent surface deterministic (only
 *    Kyberion-injected definitions plus CLI built-ins are reachable);
 *  - sub-agents default to background execution, in which case the first
 *    `result` is only a launch acknowledgement — see `isLaunchAcknowledgement`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { childDelegationEnv } from './operation-policy-gate.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import {
  buildProviderChildEnv,
  type ProviderPermissionProfileName,
} from './provider-permission-profiles.js';
import * as pathResolver from './path-resolver.js';
import type { AgentAskOptions, AgentResponse } from './agent-adapter.js';
import {
  CLAUDE_NATIVE_SUBAGENT_TOOL_NAMES,
  CLAUDE_PARENT_SESSION_TOOLS,
  buildClaudeNativeAgentDefinitions,
  claudeNativeAgentName,
  resolveClaudeNativeSessionPermission,
} from './claude-native-subagent.js';

export interface ClaudeCliSessionAdapterOptions {
  /** CLI binary. Defaults to `claude`. */
  bin?: string;
  /** Model alias or full id. Defaults to `opus`. */
  model?: string;
  /** KD-05 tier this session is provisioned for. Defaults to `implementer`. */
  profile?: ProviderPermissionProfileName;
  /** Session-level reasoning effort (`--effort`). */
  effort?: 'low' | 'medium' | 'high' | 'ultra';
  cwd?: string;
  /** Per-turn wall-clock budget. Defaults to 10 min. */
  timeoutMs?: number;
  extraArgs?: readonly string[];
  /** Test seam; production uses the standard child process implementation. */
  spawnProcess?: typeof spawn;
}

interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  is_error?: boolean;
  result?: string;
  agents?: string[];
  tools?: string[];
  message?: { content?: unknown };
}

interface ContentBlock {
  type?: string;
  name?: string;
  id?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  input?: { subagent_type?: string; run_in_background?: unknown };
}

function normalizeContentBlock(value: unknown): ContentBlock | undefined {
  if (!isRecord(value)) return undefined;
  const stringFields = ['type', 'name', 'id', 'text', 'tool_use_id'] as const;
  for (const field of stringFields) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined;
  }
  if (value.is_error !== undefined && typeof value.is_error !== 'boolean') return undefined;
  if (value.input !== undefined) {
    if (!isRecord(value.input)) return undefined;
    if (value.input.subagent_type !== undefined && typeof value.input.subagent_type !== 'string') {
      return undefined;
    }
    if (
      value.input.run_in_background !== undefined &&
      typeof value.input.run_in_background !== 'boolean'
    ) {
      return undefined;
    }
  }
  return {
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.tool_use_id === 'string' ? { tool_use_id: value.tool_use_id } : {}),
    ...(typeof value.is_error === 'boolean' ? { is_error: value.is_error } : {}),
    ...(value.content !== undefined ? { content: value.content } : {}),
    ...(isRecord(value.input)
      ? {
          input: {
            ...(typeof value.input.subagent_type === 'string'
              ? { subagent_type: value.input.subagent_type }
              : {}),
            ...(typeof value.input.run_in_background === 'boolean'
              ? { run_in_background: value.input.run_in_background }
              : {}),
          },
        }
      : {}),
  };
}

/** Normalize one untrusted Claude stream-json envelope before protocol dispatch. */
export function normalizeClaudeStreamMessage(value: unknown): StreamMessage | undefined {
  if (!isRecord(value)) return undefined;
  const stringFields = ['type', 'subtype', 'session_id', 'result'] as const;
  for (const field of stringFields) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined;
  }
  if (
    value.parent_tool_use_id !== undefined &&
    value.parent_tool_use_id !== null &&
    typeof value.parent_tool_use_id !== 'string'
  ) {
    return undefined;
  }
  if (value.is_error !== undefined && typeof value.is_error !== 'boolean') return undefined;
  for (const field of ['agents', 'tools'] as const) {
    if (
      value[field] !== undefined &&
      (!Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === 'string'))
    ) {
      return undefined;
    }
  }
  let message: StreamMessage['message'];
  if (value.message !== undefined) {
    if (!isRecord(value.message)) return undefined;
    if (value.message.content !== undefined) {
      if (!Array.isArray(value.message.content)) return undefined;
      message = {
        content: value.message.content.flatMap((block) => {
          const normalized = normalizeContentBlock(block);
          return normalized ? [normalized] : [];
        }),
      };
    } else {
      message = {};
    }
  }
  return {
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(typeof value.subtype === 'string' ? { subtype: value.subtype } : {}),
    ...(typeof value.session_id === 'string' ? { session_id: value.session_id } : {}),
    ...(typeof value.parent_tool_use_id === 'string'
      ? { parent_tool_use_id: value.parent_tool_use_id }
      : value.parent_tool_use_id === null
        ? { parent_tool_use_id: null }
        : {}),
    ...(typeof value.is_error === 'boolean' ? { is_error: value.is_error } : {}),
    ...(typeof value.result === 'string' ? { result: value.result } : {}),
    ...(Array.isArray(value.agents) ? { agents: [...value.agents] as string[] } : {}),
    ...(Array.isArray(value.tools) ? { tools: [...value.tools] as string[] } : {}),
    ...(message ? { message } : {}),
  };
}

interface ObservedDelegation {
  toolUseId: string;
  subagentType: string;
  /** The tool_use asked for background execution (or did not opt out of it). */
  background: boolean;
  /** A non-error, non-ack tool_result closed the delegation. */
  completed: boolean;
  /** The sub-agent's report, taken from that tool_result. */
  report?: string;
}

interface TurnState {
  resolve: (response: AgentResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  requireNative: boolean;
  /** The governed delegation observed in this turn, if any. */
  delegation?: ObservedDelegation;
  settled: boolean;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/** CLI `--effort` vocabulary, projected from the Kyberion effort scale. */
function resolveEffortFlag(effort?: string): string | undefined {
  if (!effort) return undefined;
  if (effort === 'ultra') return 'max';
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  return undefined;
}

export class ClaudeCliSessionAdapter {
  private readonly bin: string;
  private readonly model: string;
  private readonly profile: ProviderPermissionProfileName;
  private readonly effort?: 'low' | 'medium' | 'high' | 'ultra';
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: readonly string[];
  private readonly spawnProcess: typeof spawn;

  private child?: ChildProcessWithoutNullStreams;
  private bootPromise?: Promise<void>;
  private stdoutBuffer = '';
  private stderrTail = '';
  private turn?: TurnState;
  private sequence = 0;
  private sessionId?: string;
  private registeredAgents: string[] = [];
  private lastNativeSubagent: Record<string, unknown> | null = null;

  constructor(options: ClaudeCliSessionAdapterOptions = {}) {
    this.bin = options.bin ?? 'claude';
    this.model = options.model ?? 'opus';
    this.profile = options.profile ?? 'implementer';
    if (options.effort) this.effort = options.effort;
    this.cwd = options.cwd ?? pathResolver.rootDir();
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.extraArgs = options.extraArgs ?? [];
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  /** argv for this session. Pure — asserted directly by the unit tests. */
  buildArgs(): string[] {
    const permission = resolveClaudeNativeSessionPermission(this.profile);
    const definitions = buildClaudeNativeAgentDefinitions(this.profile);
    const effortFlag = resolveEffortFlag(this.effort);
    return [
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      this.model,
      '--tools',
      ...CLAUDE_PARENT_SESSION_TOOLS,
      '--agents',
      JSON.stringify(definitions),
      '--permission-mode',
      permission.permissionMode,
      ...(permission.disallowedTools.length > 0
        ? ['--disallowedTools', ...permission.disallowedTools]
        : []),
      // Deterministic agent surface: only Kyberion-injected definitions and
      // CLI built-ins are reachable, never unapproved user/project agents.
      '--setting-sources',
      '',
      ...(effortFlag ? ['--effort', effortFlag] : []),
      ...this.extraArgs,
    ];
  }

  async boot(): Promise<void> {
    if (this.child) return;
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(this.bin, this.buildArgs(), {
          cwd: this.cwd,
          env: { ...buildProviderChildEnv({ provider: 'claude' }), ...childDelegationEnv() },
          stdio: 'pipe',
          shell: false,
        }) as ChildProcessWithoutNullStreams;
      } catch (error) {
        reject(this.unavailable(`claude CLI session failed to start: ${describe(error)}`));
        return;
      }
      this.child = child;

      child.stdout.on('data', (chunk: Buffer | string) => this.consumeStdout(String(chunk)));
      child.stderr.on('data', (chunk: Buffer | string) => {
        this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-2000);
      });
      child.once('error', (error) => {
        const message = this.unavailable(`claude CLI session failed: ${error.message}`);
        this.forgetChild(child);
        this.failTurn(message);
        reject(message);
      });
      child.once('close', (code, signal) => {
        const message = this.unavailable(
          `claude CLI session exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})` +
            (this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-400)}` : '')
        );
        this.forgetChild(child);
        this.failTurn(message);
        reject(message);
      });
      // Nothing is emitted until the first user message, so a successful
      // spawn is the only boot signal this protocol offers.
      child.once('spawn', () => resolve());
    }).catch((error) => {
      this.bootPromise = undefined;
      throw error;
    });
    return this.bootPromise;
  }

  /** Plain turn in the shared session (no native delegation required). */
  async ask(prompt: string, options: AgentAskOptions = {}): Promise<AgentResponse> {
    return this.runTurn(prompt, options, false);
  }

  /** Native delegation turn — resolves only with observed sub-agent proof. */
  async askNativeSubagent(prompt: string, options: AgentAskOptions = {}): Promise<AgentResponse> {
    return this.runTurn(prompt, options, true);
  }

  getRuntimeInfo(): Record<string, unknown> {
    return {
      provider: 'claude',
      mode: 'cli-stream-json',
      bin: this.bin,
      model: this.model,
      profile: this.profile,
      pid: this.child?.pid ?? null,
      sessionId: this.sessionId ?? null,
      registeredAgents: [...this.registeredAgents],
      supportsNativeSubagents: this.lastNativeSubagent !== null,
      ...(this.lastNativeSubagent ? { lastNativeSubagent: { ...this.lastNativeSubagent } } : {}),
    };
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    this.forgetChild(child);
    this.failTurn(this.unavailable('claude CLI session was shut down.'));
    if (!child || child.exitCode != null || child.signalCode != null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // best-effort
        }
        finish();
      }, 2000);
      child.once('close', finish);
      try {
        if (child.stdin.writable && !child.stdin.writableEnded) child.stdin.end();
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
        finish();
      }
    });
  }

  private async runTurn(
    prompt: string,
    options: AgentAskOptions,
    requireNative: boolean
  ): Promise<AgentResponse> {
    await this.boot();
    const child = this.child;
    if (!child) throw this.unavailable('claude CLI session is not running.');
    if (this.turn) throw this.unavailable('claude CLI session already has an active turn.');
    if (options.signal?.aborted) throw this.unavailable('claude CLI turn aborted before dispatch.');

    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleTurn(this.unavailable(`claude CLI turn timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      const state: TurnState = {
        resolve,
        reject,
        timer,
        requireNative,
        settled: false,
      };
      if (options.signal) {
        state.signal = options.signal;
        state.onAbort = () => {
          this.interrupt();
          this.settleTurn(this.unavailable('claude CLI turn aborted.'));
        };
        options.signal.addEventListener('abort', state.onAbort, { once: true });
      }
      this.turn = state;

      const payload = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      };
      if (!this.send(payload)) {
        this.settleTurn(this.unavailable('claude CLI session stdin is closed.'));
      }
    });
  }

  private send(payload: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  /** Best-effort provider-side cancellation for the active turn. */
  private interrupt(): void {
    this.send({
      type: 'control_request',
      request_id: `kyberion-interrupt-${++this.sequence}`,
      request: { subtype: 'interrupt' },
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.consumeMessage(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private consumeMessage(line: string): void {
    let parsed: unknown;
    try {
      parsed = parseSafeJsonInput(line, 'Claude CLI session response');
    } catch {
      // Non-protocol noise on stdout is not fatal on its own; a turn that
      // never reaches a `result` still fails closed on its own budget.
      return;
    }
    const message = normalizeClaudeStreamMessage(parsed);
    if (!message) return;
    if (typeof message.session_id === 'string') this.sessionId = message.session_id;
    if (message.type === 'system' && message.subtype === 'init') {
      this.registeredAgents = Array.isArray(message.agents) ? [...message.agents] : [];
      this.assertAgentsRegistered();
      return;
    }
    const turn = this.turn;
    if (!turn) return;

    if (message.type === 'assistant' || message.type === 'user') {
      this.observeContent(turn, message);
      return;
    }
    if (message.type !== 'result') return;

    if (message.subtype !== 'success' || message.is_error) {
      this.settleTurn(
        this.unavailable(
          `claude CLI turn failed (${message.subtype ?? 'unknown'}): ${String(message.result ?? '').slice(0, 400)}`
        )
      );
      return;
    }
    if (turn.requireNative && turn.delegation && !turn.delegation.completed) {
      // The parent finished its turn while the delegation was still open —
      // with a background sub-agent the `result` is the parent's "agent
      // launched" text, and the report only ever arrives (paraphrased) in a
      // later auto-continued turn. Never present that as the sub-agent's
      // answer.
      this.settleTurn(
        this.unavailable(
          turn.delegation.background
            ? `claude CLI sub-agent "${turn.delegation.subagentType}" ran in the background; its report is not part of this turn's result.`
            : `claude CLI sub-agent "${turn.delegation.subagentType}" did not return a completed report in this turn.`
        )
      );
      return;
    }
    this.settleTurn(null, {
      // Prefer the delegation's own tool_result body: it is the sub-agent's
      // report, without the parent's framing or the CLI's internal agentId /
      // usage trailer.
      text: turn.delegation?.report ?? String(message.result ?? ''),
      stopReason: 'completed',
      ...(this.buildNativeMetadata(turn) ?? {}),
    });
  }

  private observeContent(turn: TurnState, message: StreamMessage): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      if (
        raw?.type === 'tool_use' &&
        typeof raw.name === 'string' &&
        CLAUDE_NATIVE_SUBAGENT_TOOL_NAMES.includes(raw.name) &&
        typeof raw.id === 'string'
      ) {
        this.observeDelegationStart(turn, raw);
        continue;
      }
      if (
        raw?.type === 'tool_result' &&
        typeof raw.tool_use_id === 'string' &&
        turn.delegation?.toolUseId === raw.tool_use_id
      ) {
        this.observeDelegationEnd(turn, raw);
      }
    }
  }

  /**
   * A delegation only counts when it targets THIS session's governed
   * definition. The CLI still exposes its own built-ins (`general-purpose`,
   * `Explore`, …), whose tool surface Kyberion does not own — starting one
   * would run work outside the KD-05 tier, so the turn fails closed.
   */
  private observeDelegationStart(turn: TurnState, block: ContentBlock): void {
    const expected = claudeNativeAgentName(this.profile);
    const subagentType = block.input?.subagent_type ?? 'unknown';
    if (subagentType !== expected) {
      // Containment: the built-in sub-agent is already running under this
      // session's permission mode, so rejecting the turn is not enough —
      // interrupt it and drop the session rather than leaving ungoverned work
      // in flight. The next delegation boots a fresh one.
      this.interrupt();
      this.settleTurn(
        this.unavailable(
          `claude CLI session started the non-governed sub-agent "${subagentType}" instead of "${expected}".`
        )
      );
      void this.shutdown().catch(() => undefined);
      return;
    }
    if (turn.delegation) return;
    turn.delegation = {
      toolUseId: block.id as string,
      subagentType,
      // Only an explicit `false` opts out of background execution.
      background: block.input?.run_in_background !== false,
      completed: false,
    };
  }

  /**
   * Completion proof is the delegation's own tool_result — and only when it
   * is neither an error nor the async launch acknowledgement (`Async agent
   * launched successfully. … The agent is working in the background.`), which
   * the CLI delivers immediately for background sub-agents.
   */
  private observeDelegationEnd(turn: TurnState, block: ContentBlock): void {
    if (!turn.delegation) return;
    if (block.is_error === true) {
      this.settleTurn(
        this.unavailable(
          `claude CLI sub-agent "${turn.delegation.subagentType}" returned a tool error.`
        )
      );
      return;
    }
    if (isAsyncLaunchAcknowledgement(block.content)) {
      turn.delegation.background = true;
      return;
    }
    turn.delegation.completed = true;
    const report = extractDelegationReport(block.content);
    if (report) turn.delegation.report = report;
  }

  private buildNativeMetadata(turn: TurnState): { metadata: Record<string, unknown> } | null {
    const delegation = turn.delegation;
    if (!delegation?.completed) {
      this.lastNativeSubagent = null;
      return null;
    }
    const nativeSubagent: Record<string, unknown> = {
      provider: 'claude',
      mode: 'cli-stream-json',
      subagentType: delegation.subagentType,
      turnId: delegation.toolUseId,
      model: this.model,
      ...(this.sessionId ? { threadId: this.sessionId } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    };
    this.lastNativeSubagent = nativeSubagent;
    return { metadata: { nativeSubagent } };
  }

  /**
   * The injected `--agents` definitions must be visible in `system/init`. A
   * missing or empty `agents` list is "registration could not be confirmed",
   * not "assume it worked" — on the native path that fails the turn closed.
   */
  private assertAgentsRegistered(): void {
    if (!this.turn?.requireNative) return;
    const expected = claudeNativeAgentName(this.profile);
    if (!this.registeredAgents.includes(expected)) {
      this.settleTurn(
        this.unavailable(
          `claude CLI session did not register the governed sub-agent "${expected}" (available: ${this.registeredAgents.join(', ') || 'none reported'}).`
        )
      );
    }
  }

  private settleTurn(error: Error | null, response?: AgentResponse): void {
    const turn = this.turn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    this.turn = undefined;
    clearTimeout(turn.timer);
    if (turn.onAbort && turn.signal) turn.signal.removeEventListener('abort', turn.onAbort);
    if (error) {
      turn.reject(error);
      return;
    }
    if (turn.requireNative) {
      const expected = claudeNativeAgentName(this.profile);
      if (!this.registeredAgents.includes(expected)) {
        turn.reject(
          this.unavailable(
            `claude CLI session never confirmed registration of the governed sub-agent "${expected}".`
          )
        );
        return;
      }
      if (!response?.metadata?.nativeSubagent) {
        turn.reject(
          this.unavailable(
            'claude CLI session returned no observable native sub-agent delegation for this turn.'
          )
        );
        return;
      }
    }
    turn.resolve(response as AgentResponse);
  }

  private failTurn(error: Error): void {
    this.settleTurn(error);
  }

  private forgetChild(child?: ChildProcessWithoutNullStreams): void {
    if (child && this.child !== child) return;
    this.child = undefined;
    this.bootPromise = undefined;
    this.stdoutBuffer = '';
  }

  private unavailable(message: string): Error {
    return message.startsWith('[SUBAGENT_UNAVAILABLE]')
      ? new Error(message)
      : new Error(`[SUBAGENT_UNAVAILABLE] ${message}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** tool_result bodies arrive either as a string or as content blocks. */
function toolResultTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? ((block as { text: string }).text as string)
        : ''
    )
    .filter((text) => text.length > 0);
}

/**
 * The immediate acknowledgement the CLI returns for a background sub-agent
 * ("Async agent launched successfully. … The agent is working in the
 * background."). It closes the tool_use but carries no report, so it must
 * never be mistaken for completion.
 */
function isAsyncLaunchAcknowledgement(content: unknown): boolean {
  const texts = toolResultTexts(content).join('\n').toLowerCase();
  if (!texts) return false;
  return (
    texts.includes('async agent launched') ||
    texts.includes('agent is working in the background') ||
    texts.includes('launched in the background')
  );
}

/**
 * The sub-agent's report: the first text block of its tool_result. Later
 * blocks carry the CLI's internal agentId / `<usage>` trailer, which is
 * explicitly not for downstream consumption.
 */
function extractDelegationReport(content: unknown): string | undefined {
  const [first] = toolResultTexts(content);
  const report = first?.trim();
  return report ? report : undefined;
}
