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
import { metrics } from './metrics.js';
import { assertReasoningEgressAllowed } from './reasoning-egress-scope.js';

/** Pull billable token counts from a result message's `usage` block (defensive). */
function extractUsageTokens(message: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
} {
  const usage = (message as { usage?: Record<string, number> })?.usage ?? {};
  return {
    prompt_tokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    completion_tokens: usage.output_tokens ?? 0,
  };
}

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
  message: unknown,
  totalCostUsd: number
): void {
  try {
    metrics.record(label, durationMs, status, {
      model,
      agent: 'claude-agent',
      usage: extractUsageTokens(message),
      sdk_cost_usd: totalCostUsd,
    });
  } catch {
    // metrics is best-effort; never disrupt reasoning
  }
}

export interface ClaudeAgentQueryParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  /** Model alias: 'opus' | 'sonnet' | 'haiku' | explicit id. Defaults to 'opus'. */
  model?: string;
  /** Abort controller for cancelling long-running queries. */
  abortController?: AbortController;
  /** Additional options passed through to query(). */
  extraOptions?: Partial<Options>;
  /** Metrics component label for usage attribution. Default 'reasoning:claude-agent'. */
  metricsLabel?: string;
}

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

export class ClaudeAgentQueryError extends Error {
  constructor(
    message: string,
    readonly code: 'no_result' | 'parse_failed' | 'agent_error',
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
  assertReasoningEgressAllowed('claude-agent');
  const jsonSchema = z.toJSONSchema(params.schema) as Record<string, unknown>;
  // The Agent SDK's json_schema output format expects a raw JSON Schema
  // object; drop the $schema header to keep the surface minimal.
  if ('$schema' in jsonSchema) delete jsonSchema['$schema'];

  const options: Options = {
    systemPrompt: params.systemPrompt,
    model: params.model ?? 'opus',
    tools: [],
    // Structured output is delivered via a StructuredOutput TOOL call, which
    // consumes a turn — maxTurns:1 made every structured query die with
    // error_max_turns (stop_reason=tool_use) before the result turn.
    maxTurns: 3,
    permissionMode: 'dontAsk',
    outputFormat: { type: 'json_schema', schema: jsonSchema },
    abortController: params.abortController,
    ...(params.extraOptions ?? {}),
  };

  const iterator = query({ prompt: params.userPrompt, options });
  const startedAt = Date.now();

  let structured: unknown;
  let sessionId = '';
  let totalCostUsd = 0;
  let numTurns = 0;
  let lastError: unknown;
  let resultMessage: unknown;

  for await (const message of iterator) {
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
    String(options.model ?? 'opus'),
    Date.now() - startedAt,
    lastError ? 'error' : 'success',
    resultMessage,
    totalCostUsd
  );

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
  extraOptions?: Partial<Options>;
  /** Metrics component label for usage attribution. Default 'reasoning:claude-agent-task'. */
  metricsLabel?: string;
}

export interface ClaudeAgentTaskResult {
  text: string;
  sessionId: string;
  totalCostUsd: number;
  numTurns: number;
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
  assertReasoningEgressAllowed('claude-agent');
  const options: Options = {
    systemPrompt: params.systemPrompt,
    model: params.model ?? 'opus',
    maxTurns: params.maxTurns ?? 8,
    permissionMode: 'default',
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
    ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
    abortController: params.abortController,
    ...(params.extraOptions ?? {}),
  };

  const iterator = query({ prompt: params.userPrompt, options });
  const startedAt = Date.now();

  let text = '';
  let sessionId = '';
  let totalCostUsd = 0;
  let numTurns = 0;
  let lastError: unknown;
  let resultMessage: unknown;

  for await (const message of iterator) {
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
    String(options.model ?? 'opus'),
    Date.now() - startedAt,
    lastError ? 'error' : 'success',
    resultMessage,
    totalCostUsd
  );

  if (lastError) {
    throw new ClaudeAgentQueryError(
      '[claude-agent-query] agentic sub-agent returned error',
      'agent_error',
      lastError
    );
  }

  return { text, sessionId, totalCostUsd, numTurns };
}
