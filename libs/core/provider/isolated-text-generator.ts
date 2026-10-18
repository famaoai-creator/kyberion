/**
 * Isolated Text Generator — the extension point for one-shot, structured
 * text generation from UNTRUSTED prompts (e.g. peer conversation auto
 * replies) with no usable tools and no execution / write authority.
 *
 * A generator is a thin adapter over a provider-specific isolated query
 * (`runClaudeAgentQuery({isolation:'strict'})`, `runCodexIsolatedQuery`).
 * Resolution fails closed: a generator is usable only when the governed
 * reasoning-provider descriptor of its `reasoningBackend`
 * (knowledge/product/governance/reasoning-providers/*.json) declares
 * `isolated_text_generation.isolation` equal to the generator's own
 * `isolation`. A generator that silently has tools therefore cannot be
 * plugged in by code alone — the governed descriptor must vouch for it too.
 *
 * Registration is in-process code only; nothing is loaded dynamically from
 * config. Adding a provider = implement the adapter here (or register it from
 * a core module), declare `isolated_text_generation` in its descriptor, and
 * pass the conformance suite
 * (`libs/core/provider/__tests__/isolated-text-generator-conformance.ts`).
 * CLI-based providers additionally need a live isolation probe and a
 * tested-version gate (see codex-isolated-query.ts).
 */

import type { ZodType } from 'zod';
import {
  getReasoningProviderDescriptor,
  ISOLATED_TEXT_GENERATION_LEVELS,
  type IsolatedTextGenerationLevel,
} from '../reasoning/reasoning-provider-registry.js';
import type { ReasoningBackendMode } from '../reasoning/reasoning-backend-policy.js';
import { runClaudeAgentQuery } from './claude-agent-query.js';
import { runCodexIsolatedQuery, TESTED_CODEX_CLI_VERSIONS } from './codex-isolated-query.js';

export type IsolatedTextGeneratorIsolation = IsolatedTextGenerationLevel;

export interface IsolatedTextGenerateInput<T> {
  systemPrompt: string;
  /** Caller-framed prompt; untrusted sections must already be framed. */
  userPrompt: string;
  schema: ZodType<T>;
  /** Aborting it stops the transport (query / child process). */
  abortController: AbortController;
  /** Wall-clock budget for one generation. */
  timeoutMs: number;
  metricsLabel?: string;
  /** Generators with a version gate only: run on an isolation-untested version. */
  allowUntestedVersion?: boolean;
}

export interface IsolatedTextGenerator {
  /** Stable id used by callers (`--auto-reply-backend <id>`). Lowercase slug. */
  id: string;
  /** Reasoning-provider mode whose descriptor must declare the isolation (egress assertion id). */
  reasoningBackend: string;
  isolation: IsolatedTextGeneratorIsolation;
  /** True when the transport refuses isolation-untested versions unless allowUntestedVersion. */
  versionGated: boolean;
  /** One-line operator-facing description of the isolation model. */
  describe(): string;
  /** Resolves with schema-validated output; rejects (never returns output) on a tool attempt. */
  generate<T>(input: IsolatedTextGenerateInput<T>): Promise<T>;
}

/** Error raised by the generator layer itself (not by a provider transport). */
export class IsolatedTextGeneratorError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'ISOLATED_GENERATOR_UNKNOWN'
      | 'ISOLATED_GENERATOR_UNDECLARED'
      | 'ISOLATED_GENERATOR_INVALID'
      | 'ISOLATED_GENERATOR_DUPLICATE'
      | 'ISOLATED_GENERATOR_TIMEOUT'
  ) {
    super(message);
    this.name = 'IsolatedTextGeneratorError';
  }
}

const GENERATOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const registry = new Map<string, IsolatedTextGenerator>();

/**
 * Register an in-process generator. Shape is validated here; the governed
 * declaration is checked at {@link resolveIsolatedTextGenerator} time.
 * Returns an unregister function.
 */
export function registerIsolatedTextGenerator(generator: IsolatedTextGenerator): () => void {
  if (
    !GENERATOR_ID_PATTERN.test(generator.id) ||
    !GENERATOR_ID_PATTERN.test(generator.reasoningBackend) ||
    !ISOLATED_TEXT_GENERATION_LEVELS.includes(generator.isolation) ||
    typeof generator.generate !== 'function' ||
    typeof generator.describe !== 'function'
  ) {
    throw new IsolatedTextGeneratorError(
      `[ISOLATED_GENERATOR_INVALID] generator ${String(generator.id)} — id/reasoningBackend must be slugs and isolation one of ${ISOLATED_TEXT_GENERATION_LEVELS.join(', ')}`,
      'ISOLATED_GENERATOR_INVALID'
    );
  }
  if (registry.has(generator.id)) {
    throw new IsolatedTextGeneratorError(
      `[ISOLATED_GENERATOR_DUPLICATE] generator ${generator.id} is already registered`,
      'ISOLATED_GENERATOR_DUPLICATE'
    );
  }
  registry.set(generator.id, generator);
  return () => {
    if (registry.get(generator.id) === generator) registry.delete(generator.id);
  };
}

/** Registered generators in registration order (not yet checked against descriptors). */
export function listIsolatedTextGenerators(): readonly IsolatedTextGenerator[] {
  return [...registry.values()];
}

/**
 * Resolve a generator by id. Fails closed with `[ISOLATED_GENERATOR_UNKNOWN]`
 * for an unregistered id and `[ISOLATED_GENERATOR_UNDECLARED]` when the
 * governed descriptor of its reasoning backend does not declare the same
 * isolation level.
 */
export function resolveIsolatedTextGenerator(id: string): IsolatedTextGenerator {
  const generator = registry.get(id.trim());
  if (!generator) {
    throw new IsolatedTextGeneratorError(
      `[ISOLATED_GENERATOR_UNKNOWN] no isolated text generator "${id}" — registered: ${[...registry.keys()].join(', ') || 'none'}`,
      'ISOLATED_GENERATOR_UNKNOWN'
    );
  }
  const descriptor = getReasoningProviderDescriptor(
    generator.reasoningBackend as ReasoningBackendMode
  );
  const declared = descriptor?.isolated_text_generation?.isolation;
  if (declared !== generator.isolation) {
    throw new IsolatedTextGeneratorError(
      `[ISOLATED_GENERATOR_UNDECLARED] generator ${generator.id} claims isolation ${generator.isolation} but reasoning provider ${generator.reasoningBackend} declares ${declared ?? 'none'} — untrusted text is never sent to an undeclared generator | next: declare isolated_text_generation in knowledge/product/governance/reasoning-providers/${generator.reasoningBackend}.json after the conformance suite and isolation probe pass`,
      'ISOLATED_GENERATOR_UNDECLARED'
    );
  }
  return generator;
}

/**
 * Link a fresh controller to the caller's and to a wall-clock budget, so a
 * transport without its own timeout is still stopped. `timedOut()` tells the
 * caller whether the budget (not the caller) aborted.
 */
function budgetedAbort(
  outer: AbortController,
  timeoutMs: number
): { controller: AbortController; timedOut(): boolean; dispose(): void } {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (outer.signal.aborted) controller.abort();
  else outer.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    controller,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      outer.signal.removeEventListener('abort', onAbort);
    },
  };
}

/** Claude Agent SDK under strict isolation: `tools: []`, no settings/MCP/hooks, scratch cwd, minimal env. */
export const CLAUDE_ISOLATED_TEXT_GENERATOR: IsolatedTextGenerator = {
  id: 'claude',
  reasoningBackend: 'claude-agent',
  isolation: 'structural',
  versionGated: false,
  describe: () =>
    'Claude Agent SDK, strict isolation (tools: [], no settings/MCP/hooks/plugins, empty scratch cwd, minimal env)',
  async generate<T>(input: IsolatedTextGenerateInput<T>): Promise<T> {
    const budget = budgetedAbort(input.abortController, input.timeoutMs);
    try {
      const result = await runClaudeAgentQuery({
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        schema: input.schema,
        abortController: budget.controller,
        ...(input.metricsLabel ? { metricsLabel: input.metricsLabel } : {}),
        isolation: 'strict',
      });
      return result.parsed;
    } catch (error) {
      if (budget.timedOut()) {
        throw new IsolatedTextGeneratorError(
          `[ISOLATED_GENERATOR_TIMEOUT] claude isolated generation exceeded ${input.timeoutMs}ms`,
          'ISOLATED_GENERATOR_TIMEOUT'
        );
      }
      throw error;
    } finally {
      budget.dispose();
    }
  },
};

/** codex CLI with every tool feature disabled, fail-closed tool-attempt detection and a tested-version gate. */
export const CODEX_ISOLATED_TEXT_GENERATOR: IsolatedTextGenerator = {
  id: 'codex',
  reasoningBackend: 'codex-cli',
  isolation: 'fail_closed_detection',
  versionGated: true,
  describe: () =>
    `codex exec, tools visible but disabled, any tool attempt discards the output (tested codex-cli: ${TESTED_CODEX_CLI_VERSIONS.join(', ')})`,
  async generate<T>(input: IsolatedTextGenerateInput<T>): Promise<T> {
    const result = await runCodexIsolatedQuery({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      schema: input.schema,
      abortController: input.abortController,
      timeoutMs: input.timeoutMs,
      ...(input.metricsLabel ? { metricsLabel: input.metricsLabel } : {}),
      allowUntestedVersion: input.allowUntestedVersion === true,
    });
    return result.parsed;
  },
};

/** Ids of the generators registered at module load. */
export const BUILTIN_ISOLATED_TEXT_GENERATOR_IDS: readonly string[] = [
  CLAUDE_ISOLATED_TEXT_GENERATOR.id,
  CODEX_ISOLATED_TEXT_GENERATOR.id,
];

registerIsolatedTextGenerator(CLAUDE_ISOLATED_TEXT_GENERATOR);
registerIsolatedTextGenerator(CODEX_ISOLATED_TEXT_GENERATOR);

/**
 * Errors that mean the model tried to use a tool and the output was
 * discarded, from any generator (`CODEX_TOOL_ATTEMPT`, `tool_attempt`, …).
 */
export function isIsolatedToolAttemptError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /tool_attempt$/iu.test(code);
}
