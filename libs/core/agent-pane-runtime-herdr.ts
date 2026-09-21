/**
 * Pane-runtime seam provider for Herdr (terminal multiplexer for coding agents).
 *
 * This is the only production module that may name the vendor. Lifecycle / A2A
 * talk to `agent-pane-runtime-bridge` using launch mode `pane` only.
 */

import type { AgentAdapter, AgentAskOptions, AgentResponse } from './agent-adapter.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { isRecord } from './foundation/text.js';
import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { safeExecResult } from './secure-io.js';
import { resolveHerdrBin } from './tool-binary-resolvers.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import {
  classifyAgentReadiness,
  describeAgentReadiness,
  type AgentReadiness,
} from './agent-runtime-readiness.js';
import {
  decideAgentPromptResponse,
  loadAgentPromptResponsePolicy,
  resolveAgentLaunchArgs,
  type AgentPromptResponsePolicy,
} from './agent-prompt-response.js';
import {
  getAgentPromptApprovalPort,
  type AgentPromptApprovalPort,
  type AgentPromptApprovalStatus,
} from './agent-prompt-approval-port.js';
import { auditChain } from './audit-chain.js';
import {
  registerAgentPaneRuntimeBridge,
  type AgentPaneRuntimeBridge,
  type AgentPaneRuntimeProbe,
  type AgentPaneRuntimeSpawnRequest,
} from './agent-pane-runtime-bridge.js';

const logger = createLogger('agent-pane-runtime-herdr');

export const HERDR_AGENT_PANE_RUNTIME_BRIDGE_ID = 'herdr' as const;

function resolveMuxBin(): string {
  return resolveHerdrBin();
}

function resolveWorkspaceLabel(): string {
  return getRegisteredEnvText('KYBERION_AGENT_PANE_RUNTIME_WORKSPACE_LABEL') || 'kyberion';
}

export const HERDR_PROVIDER_KINDS = [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'agy',
  'grok',
  'opencode',
  'copilot',
] as const;

export type HerdrProviderKind = (typeof HERDR_PROVIDER_KINDS)[number];

function isTerminalAgentStatus(status: string | undefined): boolean {
  return new Set(['error', 'failed', 'dead', 'stopped', 'exited', 'terminated']).has(
    String(status || '')
      .trim()
      .toLowerCase()
  );
}

export interface HerdrCliEnvelope {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export interface HerdrWorkspaceInfo {
  workspace_id: string;
  label?: string;
  active_tab_id?: string;
  pane_count?: number;
}

export interface HerdrPaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id?: string;
  cwd?: string;
  agent_status?: string;
}

export interface HerdrAgentInfo {
  name?: string;
  pane_id: string;
  workspace_id: string;
  agent?: string;
  agent_status?: string;
  interactive_ready?: boolean;
}

export type HerdrExecFn = (
  command: string,
  args?: string[],
  options?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> }
) => { stdout: string; stderr: string; status: number | null; error?: Error };

const PROVIDER_KIND_MAP: Record<string, HerdrProviderKind> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'cursor',
  agy: 'agy',
  grok: 'grok',
  opencode: 'opencode',
  copilot: 'copilot',
};

/** Map a Kyberion provider id to a Herdr `--kind` value, or null when unsupported. */
export function mapProviderToHerdrKind(provider: string): HerdrProviderKind | null {
  const key = String(provider || '')
    .trim()
    .toLowerCase();
  return PROVIDER_KIND_MAP[key] ?? null;
}

/**
 * Herdr agent names must match `[a-z][a-z0-9_-]{0,31}`.
 * Preserve as much of the original agent id as possible under that constraint.
 */
export function sanitizeHerdrAgentName(agentId: string): string {
  const lowered = String(agentId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const withLetter = /^[a-z]/.test(lowered) ? lowered : `a${lowered}`;
  const clipped = withLetter.slice(0, 32).replace(/-+$/g, '');
  return clipped || 'agent';
}

function parseEnvelope(stdout: string, stderr: string): HerdrCliEnvelope {
  const text = String(stdout || '').trim() || String(stderr || '').trim();
  if (!text) return { error: { code: 'empty', message: 'mux cli returned empty output' } };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return { error: { code: 'invalid_json', message: 'mux cli response was not an object' } };
    }
    return parsed as HerdrCliEnvelope;
  } catch (error: unknown) {
    return {
      error: {
        code: 'invalid_json',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function asWorkspaceList(result: unknown): HerdrWorkspaceInfo[] {
  if (!isRecord(result) || !Array.isArray(result.workspaces)) return [];
  return result.workspaces.filter(isRecord).map((row) => ({
    workspace_id: String(row.workspace_id || ''),
    label: typeof row.label === 'string' ? row.label : undefined,
    active_tab_id: typeof row.active_tab_id === 'string' ? row.active_tab_id : undefined,
    pane_count: typeof row.pane_count === 'number' ? row.pane_count : undefined,
  }));
}

function asPaneList(result: unknown): HerdrPaneInfo[] {
  if (!isRecord(result) || !Array.isArray(result.panes)) return [];
  return result.panes.filter(isRecord).map((row) => ({
    pane_id: String(row.pane_id || ''),
    workspace_id: String(row.workspace_id || ''),
    tab_id: typeof row.tab_id === 'string' ? row.tab_id : undefined,
    cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
    agent_status: typeof row.agent_status === 'string' ? row.agent_status : undefined,
  }));
}

function asAgentInfo(value: unknown): HerdrAgentInfo | null {
  if (!isRecord(value)) return null;
  const paneId = String(value.pane_id || '');
  const workspaceId = String(value.workspace_id || '');
  if (!paneId || !workspaceId) return null;
  return {
    name: typeof value.name === 'string' ? value.name : undefined,
    pane_id: paneId,
    workspace_id: workspaceId,
    agent: typeof value.agent === 'string' ? value.agent : undefined,
    agent_status: typeof value.agent_status === 'string' ? value.agent_status : undefined,
    interactive_ready:
      typeof value.interactive_ready === 'boolean' ? value.interactive_ready : undefined,
  };
}

function asAgentList(result: unknown): HerdrAgentInfo[] {
  if (!isRecord(result) || !Array.isArray(result.agents)) return [];
  return result.agents.map(asAgentInfo).filter((row): row is HerdrAgentInfo => Boolean(row));
}

export class HerdrRuntimeClient {
  private readonly bin: string;
  private readonly exec: HerdrExecFn;

  constructor(options: { bin?: string; exec?: HerdrExecFn } = {}) {
    this.bin = options.bin || resolveMuxBin();
    this.exec = options.exec || safeExecResult;
  }

  run(args: string[], timeoutMs = 30_000): HerdrCliEnvelope {
    const result = this.exec(this.bin, args, {
      timeoutMs,
      env: process.env as Record<string, string>,
    });
    const envelope = parseEnvelope(result.stdout, result.stderr);
    if (envelope.error) return envelope;
    if (result.status !== 0 && result.status !== null) {
      return {
        error: {
          code: 'nonzero_exit',
          message: `mux cli exited ${result.status}: ${result.stderr || result.stdout}`.trim(),
        },
      };
    }
    if (result.error) {
      return {
        error: {
          code: 'spawn_error',
          message: result.error.message,
        },
      };
    }
    return envelope;
  }

  listWorkspaces(): HerdrWorkspaceInfo[] {
    const envelope = this.run(['workspace', 'list']);
    if (envelope.error)
      throw new Error(`[pane-runtime] workspace list failed: ${envelope.error.message}`);
    return asWorkspaceList(envelope.result);
  }

  createWorkspace(input: { cwd: string; label: string }): {
    workspace: HerdrWorkspaceInfo;
    root_pane: HerdrPaneInfo;
  } {
    const envelope = this.run([
      'workspace',
      'create',
      '--cwd',
      input.cwd,
      '--label',
      input.label,
      '--no-focus',
    ]);
    if (envelope.error) {
      throw new Error(`[pane-runtime] workspace create failed: ${envelope.error.message}`);
    }
    if (!isRecord(envelope.result) || !isRecord(envelope.result.workspace)) {
      throw new Error('[pane-runtime] workspace create returned no workspace');
    }
    const workspace = envelope.result.workspace;
    const root = isRecord(envelope.result.root_pane) ? envelope.result.root_pane : null;
    if (!root?.pane_id) throw new Error('[pane-runtime] workspace create returned no root pane');
    return {
      workspace: {
        workspace_id: String(workspace.workspace_id || ''),
        label: typeof workspace.label === 'string' ? workspace.label : input.label,
        active_tab_id:
          typeof workspace.active_tab_id === 'string' ? workspace.active_tab_id : undefined,
      },
      root_pane: {
        pane_id: String(root.pane_id),
        workspace_id: String(root.workspace_id || workspace.workspace_id || ''),
        tab_id: typeof root.tab_id === 'string' ? root.tab_id : undefined,
        cwd: typeof root.cwd === 'string' ? root.cwd : input.cwd,
      },
    };
  }

  ensureWorkspace(input: { cwd: string; label: string }): {
    workspace: HerdrWorkspaceInfo;
    root_pane: HerdrPaneInfo;
    created: boolean;
  } {
    const existing = this.listWorkspaces().find((row) => row.label === input.label);
    if (existing?.workspace_id) {
      const panes = this.listPanes(existing.workspace_id);
      const root = panes[0];
      if (!root) {
        throw new Error(`[pane-runtime] workspace ${existing.workspace_id} has no panes`);
      }
      return { workspace: existing, root_pane: root, created: false };
    }
    const created = this.createWorkspace(input);
    return { ...created, created: true };
  }

  listPanes(workspaceId?: string): HerdrPaneInfo[] {
    const args = workspaceId ? ['pane', 'list', '--workspace', workspaceId] : ['pane', 'list'];
    const envelope = this.run(args);
    if (envelope.error)
      throw new Error(`[pane-runtime] pane list failed: ${envelope.error.message}`);
    return asPaneList(envelope.result);
  }

  splitPane(paneId: string, direction: 'right' | 'down' = 'right'): HerdrPaneInfo {
    const envelope = this.run(['pane', 'split', paneId, '--direction', direction, '--no-focus']);
    if (envelope.error)
      throw new Error(`[pane-runtime] pane split failed: ${envelope.error.message}`);
    if (!isRecord(envelope.result) || !isRecord(envelope.result.pane)) {
      throw new Error('[pane-runtime] pane split returned no pane');
    }
    const pane = envelope.result.pane;
    return {
      pane_id: String(pane.pane_id || ''),
      workspace_id: String(pane.workspace_id || ''),
      tab_id: typeof pane.tab_id === 'string' ? pane.tab_id : undefined,
      cwd: typeof pane.cwd === 'string' ? pane.cwd : undefined,
    };
  }

  listAgents(): HerdrAgentInfo[] {
    const envelope = this.run(['agent', 'list']);
    if (envelope.error)
      throw new Error(`[pane-runtime] agent list failed: ${envelope.error.message}`);
    return asAgentList(envelope.result);
  }

  startAgent(input: {
    name: string;
    kind: HerdrProviderKind;
    paneId: string;
    timeoutMs?: number;
    extraArgs?: string[];
  }): HerdrAgentInfo {
    const args = [
      'agent',
      'start',
      input.name,
      '--kind',
      input.kind,
      '--pane',
      input.paneId,
      '--timeout',
      String(input.timeoutMs ?? 60_000),
    ];
    if (input.extraArgs && input.extraArgs.length > 0) {
      args.push('--', ...input.extraArgs);
    }
    const envelope = this.run(args, (input.timeoutMs ?? 60_000) + 5_000);
    if (envelope.error)
      throw new Error(`[pane-runtime] agent start failed: ${envelope.error.message}`);
    const agent = isRecord(envelope.result) ? asAgentInfo(envelope.result.agent) : null;
    if (!agent) throw new Error('[pane-runtime] agent start returned no agent');
    return agent;
  }

  promptAgent(input: { target: string; text: string; timeoutMs?: number }): HerdrAgentInfo {
    const timeoutMs = input.timeoutMs ?? 180_000;
    const envelope = this.run(
      ['agent', 'prompt', input.target, input.text, '--wait', '--timeout', String(timeoutMs)],
      timeoutMs + 5_000
    );
    if (envelope.error)
      throw new Error(`[pane-runtime] agent prompt failed: ${envelope.error.message}`);
    const agent = isRecord(envelope.result) ? asAgentInfo(envelope.result.agent) : null;
    if (!agent) throw new Error('[pane-runtime] agent prompt returned no agent');
    return agent;
  }

  getAgent(target: string): HerdrAgentInfo {
    const envelope = this.run(['agent', 'get', target]);
    if (envelope.error)
      throw new Error(`[pane-runtime] agent get failed: ${envelope.error.message}`);
    const agent = isRecord(envelope.result) ? asAgentInfo(envelope.result.agent) : null;
    if (!agent) throw new Error('[pane-runtime] agent get returned no agent');
    return agent;
  }

  sendKeys(target: string, keys: string[]): void {
    const envelope = this.run(['agent', 'send-keys', target, ...keys]);
    if (envelope.error)
      throw new Error(`[pane-runtime] agent send-keys failed: ${envelope.error.message}`);
  }

  /** Wait until the agent is idle, done or blocked again. */
  waitAgent(target: string, timeoutMs: number): HerdrAgentInfo | null {
    const envelope = this.run(
      [
        'agent',
        'wait',
        target,
        '--until',
        'idle',
        '--until',
        'done',
        '--until',
        'blocked',
        '--timeout',
        String(timeoutMs),
      ],
      timeoutMs + 5_000
    );
    if (envelope.error)
      throw new Error(`[pane-runtime] agent wait failed: ${envelope.error.message}`);
    return isRecord(envelope.result) ? asAgentInfo(envelope.result.agent) : null;
  }

  readAgent(target: string, lines = 80): string {
    const result = this.exec(
      this.bin,
      [
        'agent',
        'read',
        target,
        '--source',
        'recent-unwrapped',
        '--lines',
        String(lines),
        '--format',
        'text',
      ],
      {
        timeoutMs: 30_000,
        env: process.env as Record<string, string>,
      }
    );
    if (result.error) {
      throw new Error(`[pane-runtime] agent read failed: ${result.error.message}`);
    }
    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');
    const trimmed = stdout.trim();
    if (trimmed.startsWith('{')) {
      const envelope = parseEnvelope(stdout, stderr);
      if (envelope.error) {
        // Fall through to raw text — some builds mix JSON errors with screen dumps.
        if (stdout.trim()) return stdout;
        throw new Error(`[pane-runtime] agent read failed: ${envelope.error.message}`);
      }
      if (typeof envelope.result === 'string') return envelope.result;
      if (isRecord(envelope.result)) {
        if (typeof envelope.result.text === 'string') return envelope.result.text;
        if (isRecord(envelope.result.read) && typeof envelope.result.read.text === 'string') {
          return envelope.result.read.text;
        }
      }
    }
    // Mux CLI commonly emits the pane screen as raw stdout (not JSON).
    if (result.status !== 0 && result.status !== null && !stdout) {
      throw new Error(
        `[pane-runtime] agent read failed (exit ${result.status}): ${stderr || 'no output'}`
      );
    }
    return stdout;
  }

  closePane(paneId: string): void {
    const envelope = this.run(['pane', 'close', paneId]);
    if (envelope.error)
      throw new Error(`[pane-runtime] pane close failed: ${envelope.error.message}`);
  }

  closeWorkspace(workspaceId: string): void {
    const envelope = this.run(['workspace', 'close', workspaceId]);
    if (envelope.error) {
      throw new Error(`[pane-runtime] workspace close failed: ${envelope.error.message}`);
    }
  }
}

export function extractPaneAssistantText(screen: string, prompt: string): string {
  const text = String(screen || '');
  const needle = String(prompt || '').trim();
  let after = text;
  if (needle) {
    const idx = text.lastIndexOf(needle);
    if (idx >= 0) after = text.slice(idx + needle.length);
  }
  const cut = after.search(/\n❯|\n─{8,}/);
  if (cut >= 0) after = after.slice(0, cut);
  return after
    .replace(/^[^\S\n]*[⏺•]\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** @deprecated Prefer extractPaneAssistantText. */
export const extractHerdrAssistantText = extractPaneAssistantText;

/** Answers per turn before giving up; stops an agent that asks forever. */
const MAX_PROMPT_ROUNDS = 5;

export interface PromptAuditEntry {
  agentName: string;
  signatureId: string;
  result: 'allowed' | 'denied';
  reason: string;
  metadata: Record<string, unknown>;
}

export interface HerdrPromptHandlingOptions {
  /** Defaults to the product policy overlaid by the personal one. */
  promptPolicy?: AgentPromptResponsePolicy;
  /** Defaults to the registered port (the approval store, when its module is loaded). */
  promptApprovals?: AgentPromptApprovalPort;
  /** Defaults to the audit chain. */
  promptAudit?: (entry: PromptAuditEntry) => void;
  /** Pause after sending keys before waiting on the agent. */
  settleDelayMs?: number;
}

function recordPromptAudit(entry: PromptAuditEntry): void {
  try {
    auditChain.record({
      agentId: entry.agentName,
      action: 'agent_prompt_response',
      operation: entry.signatureId,
      result: entry.result,
      reason: entry.reason,
      metadata: entry.metadata,
    });
  } catch (error: unknown) {
    logger.warn(
      `[pane-runtime] audit of prompt response failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HerdrPaneAgentAdapter implements AgentAdapter {
  private readonly client: HerdrRuntimeClient;
  private readonly agentId: string;
  private readonly provider: string;
  private readonly modelId?: string;
  private readonly cwd: string;
  private readonly systemPrompt?: string;
  private readonly workspaceLabel: string;
  private readonly bootTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly paneAgentName: string;
  private readonly kind: HerdrProviderKind;
  private readonly promptPolicy: AgentPromptResponsePolicy;
  private readonly promptApprovals: AgentPromptApprovalPort | null;
  private readonly promptAudit: (entry: PromptAuditEntry) => void;
  private readonly settleDelayMs: number;

  private workspaceId: string | null = null;
  private paneId: string | null = null;
  private createdWorkspace = false;
  private createdPane = false;
  private booted = false;

  constructor(
    options: AgentPaneRuntimeSpawnRequest &
      HerdrPromptHandlingOptions & { client?: HerdrRuntimeClient }
  ) {
    const kind = mapProviderToHerdrKind(options.provider);
    if (!kind) {
      throw new Error(
        `[pane-runtime] provider '${options.provider}' is not supported by this pane adapter`
      );
    }
    this.kind = kind;
    this.client = options.client || new HerdrRuntimeClient();
    this.agentId = options.agentId;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.cwd = options.cwd || pathResolver.rootDir();
    this.systemPrompt = options.systemPrompt;
    this.workspaceLabel = options.workspaceLabel || resolveWorkspaceLabel();
    this.bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 180_000;
    this.paneAgentName = sanitizeHerdrAgentName(options.agentId);
    this.promptPolicy = options.promptPolicy ?? loadAgentPromptResponsePolicy();
    this.promptApprovals = options.promptApprovals ?? getAgentPromptApprovalPort();
    this.promptAudit = options.promptAudit ?? recordPromptAudit;
    this.settleDelayMs = options.settleDelayMs ?? 1_500;
  }

  async boot(): Promise<void> {
    if (this.booted) return;

    const ensured = this.client.ensureWorkspace({
      cwd: this.cwd,
      label: this.workspaceLabel,
    });
    this.workspaceId = ensured.workspace.workspace_id;
    this.createdWorkspace = ensured.created;

    const occupied = new Set(
      this.client
        .listAgents()
        .filter((agent) => agent.workspace_id === this.workspaceId)
        .map((agent) => agent.pane_id)
    );

    let paneId = ensured.root_pane.pane_id;
    if (occupied.has(paneId)) {
      const split = this.client.splitPane(paneId, 'right');
      paneId = split.pane_id;
      this.createdPane = true;
    }
    this.paneId = paneId;

    logger.info(
      `[pane-runtime] starting ${this.paneAgentName} kind=${this.kind} pane=${paneId} workspace=${this.workspaceId}`
    );

    const extraArgs: string[] = [];
    if (this.modelId && this.kind === 'claude') {
      const normalized = this.modelId.trim().toLowerCase();
      if (normalized && normalized !== 'claude' && normalized !== this.provider.toLowerCase()) {
        extraArgs.push('--model', this.modelId);
      }
    }

    extraArgs.push(...resolveAgentLaunchArgs(this.promptPolicy, this.provider, this.kind));

    this.client.startAgent({
      name: this.paneAgentName,
      kind: this.kind,
      paneId,
      timeoutMs: this.bootTimeoutMs,
      extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
    });

    // First-run prompts (workspace trust, sign-in) appear here, and herdr
    // reports the agent started: it is at an input, just not ours.
    await this.settlePrompts(this.readScreen(), false);

    if (this.systemPrompt && this.systemPrompt.trim()) {
      try {
        this.client.promptAgent({
          target: this.paneAgentName,
          text: `System context (follow for this session):\n${this.systemPrompt.trim()}`,
          timeoutMs: this.turnTimeoutMs,
        });
      } catch (error: unknown) {
        logger.warn(
          `[pane-runtime] system prompt injection failed for ${this.paneAgentName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        await this.shutdown();
        throw new Error(
          `[pane-runtime] refusing to start ${this.paneAgentName} without its system context: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    this.booted = true;
    logger.info(`[pane-runtime] agent ${this.paneAgentName} ready in pane ${paneId}`);
  }

  async ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse> {
    if (!this.booted) await this.boot();
    const turnTimeoutMs =
      typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Number(options.timeoutMs)
        : this.turnTimeoutMs;
    const before = (() => {
      try {
        return this.client.readAgent(this.paneAgentName, 40);
      } catch {
        return '';
      }
    })();

    const promptResult = this.client.promptAgent({
      target: this.paneAgentName,
      text: prompt,
      timeoutMs: turnTimeoutMs,
    });
    if (isTerminalAgentStatus(promptResult.agent_status)) {
      throw new Error(
        `[pane-runtime] agent '${this.paneAgentName}' ended in status '${promptResult.agent_status}'`
      );
    }

    let screen = '';
    try {
      screen = this.client.readAgent(this.paneAgentName, 120);
    } catch (error: unknown) {
      logger.warn(
        `[pane-runtime] read after prompt failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      screen = before;
    }

    // An agent that stops mid-turn to ask something — "allow this tool?",
    // a clarifying question, a trust prompt — is not finished. `prompt --wait`
    // returns as soon as herdr sees it `blocked`, and this used to read the
    // screen and hand the question back as the agent's answer: dispatch then
    // treated "Allow edits to this file? (y/n)" as completed work.
    //
    // Two checks, because neither is enough alone. herdr's own `blocked`
    // status is authoritative for the prompts it understands; for the ones it
    // does not, the pane reads `idle` — an agent sitting on a trust prompt was
    // reported exactly that way — so the screen is classified as well.
    const nativeBlocked = String(promptResult.agent_status || '').toLowerCase() === 'blocked';
    screen = await this.settlePrompts(screen, nativeBlocked);

    const text = extractPaneAssistantText(screen, prompt) || screen.trim();
    if (!text || text === prompt.trim()) {
      throw new Error(`[pane-runtime] agent '${this.paneAgentName}' returned no assistant text`);
    }
    return { text, stopReason: 'completed' };
  }

  private readScreen(lines = 120): string {
    try {
      return this.client.readAgent(this.paneAgentName, lines);
    } catch {
      return '';
    }
  }

  private promptOnScreen(screen: string, blocked: boolean): AgentReadiness | null {
    const onScreen = classifyAgentReadiness(screen);
    if (onScreen.state === 'awaiting_human') return onScreen;
    if (!blocked) return null;
    return {
      state: 'awaiting_human',
      reason: `agent is waiting for a person: herdr reports '${this.paneAgentName}' as blocked`,
      promptExcerpt: screen.split('\n').slice(-12).join('\n').trim(),
      signatureId: 'agent_blocked',
    };
  }

  /**
   * Resolve whatever the agent has stopped on, and return the screen once it
   * has moved on. Allowlisted prompts are answered; the rest go to a person
   * as an approval request and their decision is relayed. Throws
   * `[AGENT_RUNTIME_AWAITING_HUMAN]` when no decision is available yet and
   * `[AGENT_RUNTIME_PROMPT_DECLINED]` when a person said no.
   */
  private async settlePrompts(initialScreen: string, initiallyBlocked: boolean): Promise<string> {
    let screen = initialScreen;
    let blocked = initiallyBlocked;
    for (let round = 0; round < MAX_PROMPT_ROUNDS; round++) {
      const prompt = this.promptOnScreen(screen, blocked);
      if (!prompt) return screen;
      const signatureId = prompt.signatureId || 'agent_blocked';
      const excerpt = prompt.promptExcerpt || screen.split('\n').slice(-12).join('\n').trim();
      const decision = decideAgentPromptResponse(this.promptPolicy, {
        signatureId,
        provider: this.provider,
        kind: this.kind,
        cwd: this.cwd,
        excerpt,
      });

      if (decision.action === 'human_only') {
        throw new Error(`[AGENT_RUNTIME_AWAITING_HUMAN] ${describeAgentReadiness(prompt)}`);
      }

      let keys: string[];
      if (decision.action === 'auto_answer') {
        keys = decision.keys;
        this.promptAudit({
          agentName: this.paneAgentName,
          signatureId,
          result: 'allowed',
          reason: decision.reason,
          metadata: { rule_id: decision.ruleId, keys, cwd: this.cwd, provider: this.provider },
        });
      } else {
        if (!this.promptApprovals) {
          throw new Error(
            `[AGENT_RUNTIME_AWAITING_HUMAN] ${describeAgentReadiness(prompt)} ` +
              'No approval channel is registered in this process, so the prompt cannot be escalated; answer it in the pane.'
          );
        }
        const { id } = this.promptApprovals.open({
          agentName: this.paneAgentName,
          provider: this.provider,
          signatureId,
          cwd: this.cwd,
          excerpt,
        });
        const status = await this.awaitPromptDecision(id, decision.waitMs);
        if (status === 'pending' || status === 'closed') {
          throw new Error(
            `[AGENT_RUNTIME_AWAITING_HUMAN] ${describeAgentReadiness(prompt)} ` +
              `Approval request ${id} is ${status === 'pending' ? 'open' : 'not usable'}: ` +
              `\`pnpm kyberion approve ${id}\` or \`pnpm kyberion reject ${id}\`; ` +
              'the next turn relays the decision.'
          );
        }
        keys = status === 'approved' ? decision.relay.approve : decision.relay.reject;
        this.client.sendKeys(this.paneAgentName, keys);
        this.promptApprovals.consume(id, true);
        this.promptAudit({
          agentName: this.paneAgentName,
          signatureId,
          result: status === 'approved' ? 'allowed' : 'denied',
          reason: `relayed a person's ${status} decision (approval ${id})`,
          metadata: { approval_id: id, keys, cwd: this.cwd, provider: this.provider },
        });
        if (status === 'rejected') {
          throw new Error(
            `[AGENT_RUNTIME_PROMPT_DECLINED] a person declined '${signatureId}' for agent '${this.paneAgentName}' (approval ${id}).`
          );
        }
        ({ screen, blocked } = await this.afterAnswer(excerpt));
        continue;
      }

      this.client.sendKeys(this.paneAgentName, keys);
      ({ screen, blocked } = await this.afterAnswer(excerpt));
    }
    throw new Error(
      `[AGENT_RUNTIME_AWAITING_HUMAN] agent '${this.paneAgentName}' stopped on ${MAX_PROMPT_ROUNDS} prompts in a row; a person should look at the pane.`
    );
  }

  /**
   * Let the answer land, then wait for the agent to settle. If the same
   * prompt is still on screen the answer did not take — resending would
   * answer twice, so that is a stop, not a retry.
   */
  private async afterAnswer(answered: string): Promise<{ screen: string; blocked: boolean }> {
    await sleep(this.settleDelayMs);
    let status: string | undefined;
    try {
      status = this.client.waitAgent(this.paneAgentName, this.turnTimeoutMs)?.agent_status;
    } catch (error: unknown) {
      logger.warn(
        `[pane-runtime] wait after answering failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const screen = this.readScreen();
    const still = this.promptOnScreen(screen, false);
    if (still?.promptExcerpt && still.promptExcerpt === answered) {
      throw new Error(
        `[AGENT_RUNTIME_AWAITING_HUMAN] the answer sent to '${this.paneAgentName}' did not take effect; the prompt is still on screen:\n${answered}`
      );
    }
    return { screen, blocked: String(status || '').toLowerCase() === 'blocked' };
  }

  private async awaitPromptDecision(
    id: string,
    waitMs: number
  ): Promise<AgentPromptApprovalStatus> {
    const deadline = Date.now() + Math.max(0, waitMs);
    const approvals = this.promptApprovals;
    if (!approvals) return 'closed';
    let status = approvals.status(id);
    if (status === 'pending' && waitMs > 0) {
      logger.warn(
        `[pane-runtime] ${this.paneAgentName} is waiting on a prompt; approval ${id} is open (waiting up to ${Math.round(waitMs / 1000)}s): pnpm kyberion approve ${id}`
      );
    }
    while (status === 'pending' && Date.now() < deadline) {
      await sleep(Math.min(2_000, Math.max(10, deadline - Date.now())));
      status = approvals.status(id);
    }
    return status;
  }

  async shutdown(): Promise<void> {
    if (!this.paneId) {
      this.booted = false;
      return;
    }
    try {
      if (this.createdPane) {
        this.client.closePane(this.paneId);
      } else if (this.createdWorkspace && this.workspaceId) {
        this.client.closeWorkspace(this.workspaceId);
      } else {
        logger.info(
          `[pane-runtime] leaving shared pane ${this.paneId} in place (agent ${this.paneAgentName})`
        );
      }
    } catch (error: unknown) {
      logger.warn(
        `[pane-runtime] shutdown cleanup failed for ${this.paneAgentName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      this.booted = false;
      this.paneId = null;
      this.workspaceId = null;
    }
  }

  getRuntimeInfo(): Record<string, unknown> {
    let status: string | undefined;
    try {
      if (this.booted) status = this.client.getAgent(this.paneAgentName).agent_status;
    } catch {
      status = undefined;
    }
    return {
      backend: 'pane',
      pane_runtime_provider: HERDR_AGENT_PANE_RUNTIME_BRIDGE_ID,
      provider: this.provider,
      modelId: this.modelId,
      pane_agent_name: this.paneAgentName,
      pane_kind: this.kind,
      pane_id: this.paneId,
      workspace_id: this.workspaceId,
      workspace_label: this.workspaceLabel,
      agent_status: status,
      supportsSoftRefresh: false,
      stateless: false,
    };
  }
}

export class HerdrAgentPaneRuntimeBridge implements AgentPaneRuntimeBridge {
  readonly bridge_id = HERDR_AGENT_PANE_RUNTIME_BRIDGE_ID;

  constructor(
    private readonly options: { bin?: string; exec?: HerdrExecFn } & HerdrPromptHandlingOptions = {}
  ) {}

  async probe(): Promise<AgentPaneRuntimeProbe> {
    const runtime = probeToolRuntime('herdr', 'trial');
    const client = new HerdrRuntimeClient(this.options);
    try {
      client.listWorkspaces();
      return { available: true };
    } catch (error: unknown) {
      const base = error instanceof Error ? error.message : String(error);
      if (runtime.requires_install || runtime.selected_action === 'install') {
        return {
          available: false,
          reason: `${base}; install via \`pnpm tool:setup -- --tool herdr --apply\` (${runtime.reason})`,
        };
      }
      return { available: false, reason: base };
    }
  }

  createAdapter(request: AgentPaneRuntimeSpawnRequest): AgentAdapter {
    const { bin, exec, ...promptHandling } = this.options;
    return new HerdrPaneAgentAdapter({
      ...request,
      ...promptHandling,
      client: new HerdrRuntimeClient({ bin, exec }),
    });
  }
}

export function registerHerdrAgentPaneRuntimeBridge(
  options: { bin?: string; exec?: HerdrExecFn } = {}
): () => void {
  return registerAgentPaneRuntimeBridge(new HerdrAgentPaneRuntimeBridge(options));
}

registerHerdrAgentPaneRuntimeBridge();
