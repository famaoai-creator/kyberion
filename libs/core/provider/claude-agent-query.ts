import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import { assertOperatorNativeCredentialOwner } from '../agent/native-credential-fence.js';
/**
 * Claude Agent Query Helper — thin wrapper around @anthropic-ai/claude-agent-sdk
 * for one-shot structured-output reasoning tasks.
 *
 * Enforces:
 *   - `tools: []` — no tool access (pure reasoning, no file / shell side effects)
 *   - `maxTurns: 1` — single turn; assistant responds once
 *   - `outputFormat: { type: 'json_schema' }` — result message carries
 *     `structured_output` validated against the supplied JSON Schema
 *   - Zod validation on the client side as a belt-and-braces check
 *
 * When the parent process is a Claude Code session, the sub-agent reuses
 * the parent's credentials (standard env inheritance). When standalone,
 * Anthropic Agent SDK falls back to ANTHROPIC_API_KEY just like the direct
 * SDK path — but the architecture honors the CLI-harness coordination
 * model: Kyberion never calls the API itself, a sub-agent does.
 */

import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CLAUDE_NATIVE_SUBAGENT_TOOL_NAMES } from './claude-native-subagent.js';
import {
  buildProviderChildEnv,
  PROVIDER_ENV_ALLOWLIST_ESCAPE_HATCH_VAR,
} from './provider-permission-profiles.js';
import { logger } from '../core.js';
import { parseClaudeCliUsage, recordCliUsage } from '../cli-usage-metering.js';
import { childDelegationEnv } from '../operation-policy-gate.js';
import {
  createScratchWorkspace,
  deleteRegisteredWorkspace,
} from '../workforce/workspace-ledger.js';
import { assertReasoningEgressAllowed } from '../reasoning/reasoning-egress-scope.js';
import { resolveRuntimeModelId } from '../tool/runtime-model-defaults.js';

/**
 * Record a claude-agent sub-agent call into the metrics collector so completed
 * reasoning is attributed by component + model with token/cost aggregation.
 * Best-effort: never throws into the reasoning path.
 */
function recordClaudeAgentMetrics(
  label: string,
  model: string,
  durationMs: number,
  status: 'success' | 'error',
  message: unknown
): void {
  try {
    recordCliUsage(label, model, Date.now() - durationMs, status, {
      report: message ? parseClaudeCliUsage(JSON.stringify(message)) : undefined,
      agent: 'claude-agent',
      cause: 'subagent',
      promptChars: 0,
      completionChars: 0,
      allowCharacterEstimate: false,
    });
  } catch {
    // metrics is best-effort; never disrupt reasoning
  }
}

export interface ClaudeAgentQueryParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  /** Model alias or explicit id. Defaults to runtime_defaults['anthropic-default']. */
  model?: string;
  /** Abort controller for cancelling long-running queries. */
  abortController?: AbortController;
  /** Additional options passed through to query(). */
  extraOptions?: Partial<Options>;
  /** Metrics component label for usage attribution. Default 'reasoning:claude-agent'. */
  metricsLabel?: string;
  /**
   * `'strict'` runs the sub-agent in SDK isolation mode for untrusted prompts
   * (e.g. peer messages): no filesystem settings (so no repo hooks, CLAUDE.md
   * or permission rules), no MCP servers / plugins / agents / skills, no
   * session persistence, a minimal env with no KYBERION_* runtime state, and
   * `cwd` set to a fresh, empty scratch dir inside the runtime floor
   * (`active/shared/runtime/workspaces/<id>/`, i.e. still under the repo
   * root — `settingSources: []` and the custom `systemPrompt` are what keep
   * repo context out, not the directory). `extraOptions` is reduced to
   * {@link STRICT_ISOLATION_EXTRA_OPTION_KEYS}. Omitted = legacy behaviour.
   */
  isolation?: ClaudeAgentIsolation;
}

/** Isolation level for {@link runClaudeAgentQuery}. */
export type ClaudeAgentIsolation = 'strict';

export interface ClaudeAgentQueryResult<T> {
  parsed: T;
  /** Raw structured_output from the Agent SDK (pre-Zod validation). */
  raw: unknown;
  /** Session ID for traceability. */
  sessionId: string;
  /** Total cost in USD as reported by the Agent SDK. */
  totalCostUsd: number;
  /** Number of turns (always 1 for one-shot queries; included for parity). */
  numTurns: number;
}

/**
 * Options that define the Kyberion governance boundary. Callers may provide
 * harmless SDK tuning through `extraOptions`, but they must not be able to
 * replace the prompt, tools, permission gate, MCP servers, or turn budget that
 * this wrapper establishes.
 */
const GOVERNED_EXTRA_OPTION_KEYS = [
  'systemPrompt',
  'model',
  'tools',
  'maxTurns',
  'permissionMode',
  'outputFormat',
  'abortController',
  'mcpServers',
  'allowedTools',
  'canUseTool',
  'agents',
  'settingSources',
  'settings',
  'plugins',
  'hooks',
  'cwd',
  'env',
] as const;

/**
 * Under strict isolation `extraOptions` is an allowlist, not a denylist: only
 * these pure model/budget tuning keys pass. Everything else (extraArgs,
 * executable overrides, projectConfigRoot, managedSettings, resume, …) could
 * reload settings/hooks/MCP or alter the spawned process.
 */
export const STRICT_ISOLATION_EXTRA_OPTION_KEYS = [
  'maxBudgetUsd',
  'thinking',
  'effort',
  'maxThinkingTokens',
  'fallbackModel',
] as const;

function strictIsolationExtraOptions(extraOptions?: Partial<Options>): Partial<Options> {
  const source = (extraOptions ?? {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if ((STRICT_ISOLATION_EXTRA_OPTION_KEYS as readonly string[]).includes(key)) kept[key] = value;
    else dropped.push(key);
  }
  if (dropped.length > 0) {
    logger.debug(
      `[claude-agent-query] strict isolation dropped extraOptions keys: ${dropped.join(', ')}`
    );
  }
  return kept as Partial<Options>;
}

function sanitizeClaudeAgentExtraOptions(extraOptions?: Partial<Options>): Partial<Options> {
  const sanitized = { ...(extraOptions ?? {}) } as Record<string, unknown>;
  for (const key of GOVERNED_EXTRA_OPTION_KEYS) delete sanitized[key];
  return sanitized as Partial<Options>;
}

/** Env prefixes dropped under strict isolation (Kyberion runtime state, mission authority). */
const STRICT_ISOLATION_DROPPED_ENV_PREFIXES = ['KYBERION_', 'MISSION_'] as const;

/**
 * Minimal env for a strictly isolated sub-agent. Starts from the same XP-02
 * allowlist the claude-cli backend spawns with (`buildProviderChildEnv`:
 * PATH/HOME/USER/locale/shell/tmp/proxy+CA plumbing and only claude's own
 * `ANTHROPIC_API_KEY`; HOME/USER keep the CLI's OAuth keychain/credentials
 * reachable), ignores the full-inheritance escape hatch, then drops every
 * KYBERION_* / MISSION_* var — the isolated child is not Kyberion-aware, and
 * those vars (peer shared secrets, mission/session ids, co-session state)
 * would let it find or act on the operator session. Only the delegation
 * depth is re-added so recursion guards still see the hop.
 */
export function buildClaudeAgentIsolatedEnv(
  baseEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const base = { ...baseEnv };
  delete base[PROVIDER_ENV_ALLOWLIST_ESCAPE_HATCH_VAR];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    buildProviderChildEnv({ provider: 'claude', baseEnv: base })
  )) {
    if (value === undefined) continue;
    if (STRICT_ISOLATION_DROPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return { ...env, ...childDelegationEnv() };
}

interface IsolationScope {
  options: Partial<Options>;
  release(): void;
}

function openIsolationScope(isolation: ClaudeAgentIsolation | undefined): IsolationScope | null {
  if (isolation !== 'strict') return null;
  const workspace = createScratchWorkspace({});
  let released = false;
  return {
    options: {
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      plugins: [],
      hooks: {},
      agents: {},
      skills: [],
      persistSession: false,
      cwd: workspace.path,
      env: buildClaudeAgentIsolatedEnv(),
    },
    release: () => {
      if (released) return;
      released = true;
      try {
        deleteRegisteredWorkspace(workspace.id);
      } catch (error) {
        logger.warn(
          `[claude-agent-query] isolated scratch cleanup failed — ${(error as Error).message} | next: workspace reclaim sweeps it | evidence: ${workspace.path}`
        );
      }
    },
  };
}

/**
 * The only tool a strictly isolated one-shot query may call: the SDK's
 * synthetic structured-output tool (`outputFormat: json_schema`). The
 * sub-agent runs with `tools: []`, so any other tool_use is unexpected.
 */
export const CLAUDE_STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';

/**
 * Defence in depth for strict isolation: evidence when an assistant message
 * carries a tool_use other than {@link CLAUDE_STRUCTURED_OUTPUT_TOOL_NAME}.
 */
export function detectClaudeStrictToolAttempt(message: unknown): string | undefined {
  const envelope = message as { type?: unknown; message?: { content?: unknown } } | null;
  if (envelope?.type !== 'assistant') return undefined;
  const content = envelope.message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content as { type?: unknown; name?: unknown }[]) {
    if (block?.type !== 'tool_use') continue;
    if (block.name === CLAUDE_STRUCTURED_OUTPUT_TOOL_NAME) continue;
    return `tool_use ${typeof block.name === 'string' ? block.name.slice(0, 100) : '<unnamed>'}`;
  }
  return undefined;
}

export class ClaudeAgentQueryError extends Error {
  constructor(
    message: string,
    readonly code: 'no_result' | 'parse_failed' | 'agent_error' | 'tool_attempt',
    readonly detail?: unknown
  ) {
    super(message);
    this.name = 'ClaudeAgentQueryError';
  }
}

/**
 * Run a one-shot structured-output query against Claude via the Agent SDK.
 *
 * Resolves with parsed + typed output when the sub-agent returns cleanly;
 * rejects with ClaudeAgentQueryError on schema-mismatch or agent failure.
 */
export async function runClaudeAgentQuery<T>(
  params: ClaudeAgentQueryParams<T>
): Promise<ClaudeAgentQueryResult<T>> {
  assertOperatorNativeCredentialOwner(credentialExecutionIdentity());
  assertReasoningEgressAllowed('claude-agent');
  const jsonSchema = z.toJSONSchema(params.schema) as Record<string, unknown>;
  // The Agent SDK's json_schema output format expects a raw JSON Schema
  // object; drop the $schema header to keep the surface minimal.
  if ('$schema' in jsonSchema) delete jsonSchema['$schema'];

  const isolation = openIsolationScope(params.isolation);
  try {
    return await runStructuredQuery(params, jsonSchema, isolation?.options);
  } finally {
    isolation?.release();
  }
}

async function runStructuredQuery<T>(
  params: ClaudeAgentQueryParams<T>,
  jsonSchema: Record<string, unknown>,
  isolationOptions: Partial<Options> | undefined
): Promise<ClaudeAgentQueryResult<T>> {
  const options: Options = {
    ...(isolationOptions
      ? strictIsolationExtraOptions(params.extraOptions)
      : sanitizeClaudeAgentExtraOptions(params.extraOptions)),
    // Isolation fields are applied after sanitization, so extraOptions can
    // never re-introduce settings, MCP servers, cwd or env.
    ...(isolationOptions ?? {}),
    systemPrompt: params.systemPrompt,
    model: params.model ?? resolveRuntimeModelId('anthropic-default'),
    tools: [],
    // Structured output is delivered via a StructuredOutput TOOL call, which
    // consumes a turn — maxTurns:1 made every structured query die with
    // error_max_turns (stop_reason=tool_use) before the result turn.
    maxTurns: 3,
    permissionMode: 'dontAsk',
    outputFormat: { type: 'json_schema', schema: jsonSchema },
    abortController: params.abortController,
  };

  assertOperatorNativeCredentialOwner(credentialExecutionIdentity());
  const iterator = query({ prompt: params.userPrompt, options });
  const startedAt = Date.now();

  let structured: unknown;
  let sessionId = '';
  let totalCostUsd = 0;
  let numTurns = 0;
  let lastError: unknown;
  let resultMessage: unknown;
  let toolAttempt: string | undefined;

  for await (const message of iterator) {
    if (isolationOptions) {
      toolAttempt = detectClaudeStrictToolAttempt(message);
      // Leaving the loop closes the SDK query; nothing after the attempt is used.
      if (toolAttempt) break;
    }
    if (message.type === 'result') {
      resultMessage = message;
      if (message.subtype === 'success') {
        structured = (message as { structured_output?: unknown }).structured_output;
        sessionId = (message as { session_id?: string }).session_id ?? '';
        totalCostUsd = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
        numTurns = (message as { num_turns?: number }).num_turns ?? 0;
      } else {
        lastError = message;
      }
      break;
    }
    if (message.type === 'assistant' && (message as any).error) {
      lastError = (message as any).error;
    }
  }

  recordClaudeAgentMetrics(
    params.metricsLabel ?? 'reasoning:claude-agent',
    String(options.model ?? resolveRuntimeModelId('anthropic-default')),
    Date.now() - startedAt,
    lastError || toolAttempt ? 'error' : 'success',
    resultMessage
  );

  if (toolAttempt) {
    throw new ClaudeAgentQueryError(
      `[claude-agent-query] strictly isolated sub-agent attempted a tool — output discarded | next: inspect the prompt; never relax strict isolation | evidence: ${toolAttempt}`,
      'tool_attempt',
      { evidence: toolAttempt }
    );
  }

  if (lastError) {
    throw new ClaudeAgentQueryError(
      `[claude-agent-query] sub-agent returned error`,
      'agent_error',
      lastError
    );
  }

  if (structured === undefined) {
    throw new ClaudeAgentQueryError(
      `[claude-agent-query] sub-agent did not emit structured_output`,
      'no_result'
    );
  }

  const parseResult = params.schema.safeParse(structured);
  if (!parseResult.success) {
    throw new ClaudeAgentQueryError(
      `[claude-agent-query] schema validation failed: ${parseResult.error.message}`,
      'parse_failed',
      { structured, issues: parseResult.error.issues }
    );
  }

  return {
    parsed: parseResult.data,
    raw: structured,
    sessionId,
    totalCostUsd,
    numTurns,
  };
}

export interface ClaudeAgentTaskParams {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  abortController?: AbortController;
  /** MCP servers exposed to the sub-agent (e.g. Kyberion's governed surface). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Advisory tool allowlist; the real enforcement is `canUseTool`. */
  allowedTools?: string[];
  /** Governance gate invoked before each tool call. */
  canUseTool?: CanUseTool;
  /** Multi-turn budget for the agentic loop. Defaults to 8. */
  maxTurns?: number;
  /** CN-05: sub-agent definitions this turn may delegate to (`Options.agents`). */
  agents?: Options['agents'];
  extraOptions?: Partial<Options>;
  /** Metrics component label for usage attribution. Default 'reasoning:claude-agent-task'. */
  metricsLabel?: string;
}

/** Proof that a provider-native sub-agent actually ran during the turn. */
export interface ObservedNativeSubagent {
  toolUseId: string;
  subagentType: string;
  /** The delegation returned a real report inside this turn. */
  completed: boolean;
  /**
   * The delegation was started in background mode, so its report is not part
   * of this turn (the tool_result is only a launch acknowledgement).
   */
  background: boolean;
  /** The delegation's tool_result was an error. */
  failed?: boolean;
}

export interface ClaudeAgentTaskResult {
  text: string;
  sessionId: string;
  totalCostUsd: number;
  numTurns: number;
  /**
   * CN-05: null unless the SDK stream proved a native delegation happened.
   * Callers that promise native execution must fail closed on null instead
   * of presenting an ordinary agent turn as a sub-agent delegation.
   */
  nativeSubagent?: ObservedNativeSubagent | null;
}

/**
 * Run an **agentic** (multi-turn, tool-using) sub-agent task and return its final
 * text. Unlike {@link runClaudeAgentQuery} (one-shot, `tools: []`, json_schema),
 * this path enables tools — intended to be driven by Kyberion governance
 * (`mcpServers` + `canUseTool` from `claude-agent-governance.ts`).
 */
export async function runClaudeAgentTask(
  params: ClaudeAgentTaskParams
): Promise<ClaudeAgentTaskResult> {
  assertOperatorNativeCredentialOwner(credentialExecutionIdentity());
  assertReasoningEgressAllowed('claude-agent');
  const options: Options = {
    ...sanitizeClaudeAgentExtraOptions(params.extraOptions),
    systemPrompt: params.systemPrompt,
    model: params.model ?? resolveRuntimeModelId('anthropic-default'),
    maxTurns: params.maxTurns ?? 8,
    permissionMode: 'default',
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
    ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
    ...(params.agents ? { agents: params.agents } : {}),
    abortController: params.abortController,
  };

  assertOperatorNativeCredentialOwner(credentialExecutionIdentity());
  const iterator = query({ prompt: params.userPrompt, options });
  const startedAt = Date.now();

  let text = '';
  let sessionId = '';
  let totalCostUsd = 0;
  let numTurns = 0;
  let lastError: unknown;
  let resultMessage: unknown;
  let nativeSubagent: ObservedNativeSubagent | null = null;

  for await (const message of iterator) {
    nativeSubagent = observeNativeSubagent(message, nativeSubagent);
    if (message.type === 'result') {
      resultMessage = message;
      if (message.subtype === 'success') {
        text = (message as { result?: string }).result ?? '';
        sessionId = (message as { session_id?: string }).session_id ?? '';
        totalCostUsd = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
        numTurns = (message as { num_turns?: number }).num_turns ?? 0;
      } else {
        lastError = message;
      }
      break;
    }
    if (message.type === 'assistant' && (message as any).error) {
      lastError = (message as any).error;
    }
  }

  recordClaudeAgentMetrics(
    params.metricsLabel ?? 'reasoning:claude-agent-task',
    String(options.model ?? resolveRuntimeModelId('anthropic-default')),
    Date.now() - startedAt,
    lastError ? 'error' : 'success',
    resultMessage
  );

  if (lastError) {
    throw new ClaudeAgentQueryError(
      '[claude-agent-query] agentic sub-agent returned error',
      'agent_error',
      lastError
    );
  }

  return { text, sessionId, totalCostUsd, numTurns, nativeSubagent };
}

/**
 * CN-05 observation gate: a delegation counts as native only when the stream
 * carries a `Task`/`Agent` tool_use with a `subagent_type`, and it counts as
 * *completed* only when that tool_use is closed by a tool_result that is
 * neither an error nor the background launch acknowledgement.
 *
 * Messages merely *scoped* to the delegation (`parent_tool_use_id`) are not
 * completion: a background sub-agent emits those too, while its report never
 * reaches this turn.
 */
function observeNativeSubagent(
  message: unknown,
  current: ObservedNativeSubagent | null
): ObservedNativeSubagent | null {
  const envelope = message as { message?: { content?: unknown } };
  let observed = current;
  const content = envelope.message?.content;
  if (!Array.isArray(content)) return observed;
  for (const raw of content as {
    type?: string;
    name?: string;
    id?: string;
    tool_use_id?: string;
    is_error?: boolean;
    content?: unknown;
    input?: { subagent_type?: string; run_in_background?: unknown };
  }[]) {
    if (
      !observed &&
      raw?.type === 'tool_use' &&
      typeof raw.name === 'string' &&
      CLAUDE_NATIVE_SUBAGENT_TOOL_NAMES.includes(raw.name) &&
      typeof raw.id === 'string'
    ) {
      observed = {
        toolUseId: raw.id,
        subagentType: raw.input?.subagent_type ?? 'unknown',
        background: raw.input?.run_in_background !== false,
        completed: false,
      };
      continue;
    }
    if (
      observed &&
      raw?.type === 'tool_result' &&
      typeof raw.tool_use_id === 'string' &&
      raw.tool_use_id === observed.toolUseId
    ) {
      if (raw.is_error === true) {
        observed = { ...observed, failed: true };
        continue;
      }
      if (isAsyncLaunchAcknowledgement(raw.content)) {
        observed = { ...observed, background: true };
        continue;
      }
      observed = { ...observed, completed: true };
    }
  }
  return observed;
}

/** tool_result bodies arrive either as a string or as content blocks. */
function toolResultTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .filter((text) => text.length > 0);
}

/**
 * The immediate acknowledgement returned for a background sub-agent ("Async
 * agent launched successfully. … The agent is working in the background.").
 * It closes the tool_use but carries no report.
 */
function isAsyncLaunchAcknowledgement(content: unknown): boolean {
  const text = toolResultTexts(content).join('\n').toLowerCase();
  if (!text) return false;
  return (
    text.includes('async agent launched') ||
    text.includes('agent is working in the background') ||
    text.includes('launched in the background')
  );
}
