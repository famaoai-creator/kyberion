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

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

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
    readonly detail?: unknown,
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
  params: ClaudeAgentQueryParams<T>,
): Promise<ClaudeAgentQueryResult<T>> {
  const jsonSchema = z.toJSONSchema(params.schema) as Record<string, unknown>;
  // The Agent SDK's json_schema output format expects a raw JSON Schema
  // object; drop the $schema header to keep the surface minimal.
  if ('$schema' in jsonSchema) delete jsonSchema['$schema'];

  const options: Options = {
    systemPrompt: params.systemPrompt,
    model: params.model ?? 'opus',
    tools: [],
    maxTurns: 1,
    permissionMode: 'dontAsk',
    outputFormat: { type: 'json_schema', schema: jsonSchema },
    abortController: params.abortController,
    ...(params.extraOptions ?? {}),
  };

  const iterator = query({ prompt: params.userPrompt, options });

  let structured: unknown;
  let sessionId = '';
  let totalCostUsd = 0;
  let numTurns = 0;
  let lastError: unknown;

  for await (const message of iterator) {
    if (message.type === 'result') {
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

  if (lastError) {
    throw new ClaudeAgentQueryError(
      `[claude-agent-query] sub-agent returned error`,
      'agent_error',
      lastError,
    );
  }

  if (structured === undefined) {
    throw new ClaudeAgentQueryError(
      `[claude-agent-query] sub-agent did not emit structured_output`,
      'no_result',
    );
  }

  const parseResult = params.schema.safeParse(structured);
  if (!parseResult.success) {
    throw new ClaudeAgentQueryError(
      `[claude-agent-query] schema validation failed: ${parseResult.error.message}`,
      'parse_failed',
      { structured, issues: parseResult.error.issues },
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
