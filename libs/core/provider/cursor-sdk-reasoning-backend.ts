/**
 * Cursor SDK Reasoning Backend — ReasoningBackend backed by `@cursor/sdk`
 * (`Agent.create` → `send` → `wait`) instead of spawning the `cursor-agent`
 * CLI. The Cursor counterpart of `ClaudeAgentReasoningBackend`.
 *
 * Scope: tool-less text reasoning. Calls are one-shot unless the caller sets
 * `context_mode` ('fresh' | 'continue'), which opts in to a continued
 * conversation held by this instance (serialized, idle-TTL'd, reset on failure
 * and by `resetSession()`). The SDK agent runs with
 * `tools: []` in an empty scratch workspace, so `delegateTask` here is advisory
 * text, not agentic tool work (the descriptor declares `tool_calling: false`
 * and `native_subagent: false`). Cursor has no native JSON-schema output
 * format, so structured ops reuse {@link runStructuredReasoningOp}
 * (prompt-enforced JSON + Zod validation), exactly like `cursor-cli`.
 *
 * Auth is `CURSOR_API_KEY` — from the environment or the secret registered with
 * `pnpm kyberion secret introduce cursor API_KEY`. Operator credentials only.
 */

import { logger } from '../core.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import {
  runStructuredReasoningOp,
  structuredReasoningSpecs,
  STRUCTURED_REASONING_SYSTEM_PROMPT,
  type StructuredOpSpec,
} from '../reasoning/structured-reasoning.js';
import { schemaHint } from '../reasoning/structured-schema-hint.js';
import { runStartReportingDelegation } from '../workforce/delegation-execution-tracker.js';
import { withRedactedProviderOutput } from './provider-output-redaction.js';
import {
  CURSOR_SDK_DEFAULT_MODEL,
  CURSOR_SDK_DEFAULT_SESSION_IDLE_TTL_MS,
  CURSOR_SDK_DEFAULT_TIMEOUT_MS,
  CursorSdkSession,
  resolveCursorSdkApiKey,
  runCursorSdkText,
  type CursorSdkQueryDeps,
  type CursorSdkRuntime,
} from './cursor-sdk-query.js';
import type {
  BranchForkInput,
  CritiqueInput,
  CritiqueResult,
  DecomposeIntoTasksInput,
  DecomposedTaskPlan,
  DivergeHypothesisInput,
  ExtractDesignSpecInput,
  ExtractRequirementsInput,
  ExtractTestPlanInput,
  ExtractedDesignSpec,
  ExtractedRequirements,
  ExtractedTestPlan,
  ForkedBranch,
  HypothesisSketch,
  PersonaSynthesisInput,
  ReasoningBackend,
  ReasoningCallOptions,
  SimulationInput,
  SimulationResult,
  SynthesizedPersona,
} from '../reasoning/reasoning-backend.js';

export interface CursorSdkReasoningBackendOptions {
  /** Cursor model id. Defaults to `composer-2.5`. */
  model?: string;
  /** Per-call timeout. Defaults to 5 min. */
  timeoutMs?: number;
  /** Use the SDK's native `systemPrompt` (account-gated; see `CursorSdkQueryParams`). Default off. */
  nativeSystemPrompt?: boolean;
  /** Idle time after which a continued conversation is released. Defaults to 15 min. */
  sessionIdleTtlMs?: number;
  /** Test seam: replaces the lazily loaded `@cursor/sdk`. */
  runtime?: CursorSdkRuntime;
  /** Test seam: operator key override. */
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CursorSdkAvailability {
  available: boolean;
  reason?: string;
}

export class CursorSdkReasoningBackend implements ReasoningBackend {
  readonly name = 'cursor-sdk';
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly nativeSystemPrompt: boolean;
  private readonly session: CursorSdkSession;
  private readonly queryDeps: CursorSdkQueryDeps;

  constructor(options: CursorSdkReasoningBackendOptions = {}) {
    this.model = options.model?.trim() || CURSOR_SDK_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? CURSOR_SDK_DEFAULT_TIMEOUT_MS;
    this.nativeSystemPrompt = options.nativeSystemPrompt === true;
    this.session = new CursorSdkSession(
      options.sessionIdleTtlMs ?? CURSOR_SDK_DEFAULT_SESSION_IDLE_TTL_MS
    );
    this.queryDeps = {
      ...(options.runtime ? { runtime: options.runtime } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.env ? { env: options.env } : {}),
    };
  }

  /**
   * Declared on the backend, not the descriptor: a descriptor `runtime_instructions`
   * block would also win the bare `cursor` provider lookup that the agentic
   * `cursor-cli` projections rely on.
   */
  getRuntimeInstructions(): string[] {
    return [
      'Provider note: Cursor SDK runs with no tools in an empty scratch workspace; it can only answer with text, so do not ask it to read files or run commands.',
      'Provider note: return structured results as JSON matching the requested shape; Kyberion validates it.',
    ];
  }

  /**
   * Drops the continued conversation (after any in-flight turn). Called on a
   * failover switch so a later call never sees a stale provider session.
   */
  async resetSession(): Promise<void> {
    await this.session.reset();
  }

  private async runStructured<TInput, TOutput>(
    spec: StructuredOpSpec<TInput, TOutput>,
    input: TInput,
    options?: ReasoningCallOptions
  ): Promise<TOutput> {
    // Output is prompt-enforced (no native JSON mode), so a malformed reply gets
    // exactly one repair round that feeds the validation failure back.
    let repairNote = '';
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await runStructuredReasoningOp(spec, input, (systemPrompt, userPrompt) =>
          this.complete(systemPrompt, `${userPrompt}${repairNote}`, {
            signal: options?.signal,
            model: options?.model,
            contextMode: options?.context_mode,
            shapeHint: schemaHint(spec.schema),
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 1 || !message.startsWith('[structured-reasoning]')) throw error;
        logger.debug(
          `[cursor-sdk] structured op "${spec.op}" invalid; retrying once with repair note`
        );
        repairNote = `\n\nYour previous reply was rejected: ${message.slice(0, 800)}\nReply again with only the corrected JSON.`;
      }
    }
  }

  divergePersonas(
    input: DivergeHypothesisInput,
    options?: ReasoningCallOptions
  ): Promise<HypothesisSketch[]> {
    return this.runStructured(structuredReasoningSpecs.divergePersonas, input, options);
  }

  crossCritique(input: CritiqueInput, options?: ReasoningCallOptions): Promise<CritiqueResult> {
    return this.runStructured(structuredReasoningSpecs.crossCritique, input, options);
  }

  synthesizePersona(
    input: PersonaSynthesisInput,
    options?: ReasoningCallOptions
  ): Promise<SynthesizedPersona> {
    return this.runStructured(structuredReasoningSpecs.synthesizePersona, input, options);
  }

  forkBranches(input: BranchForkInput, options?: ReasoningCallOptions): Promise<ForkedBranch[]> {
    return this.runStructured(structuredReasoningSpecs.forkBranches, input, options);
  }

  simulateBranches(
    input: SimulationInput,
    options?: ReasoningCallOptions
  ): Promise<SimulationResult> {
    return this.runStructured(structuredReasoningSpecs.simulateBranches, input, options);
  }

  extractRequirements(
    input: ExtractRequirementsInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedRequirements> {
    return this.runStructured(structuredReasoningSpecs.extractRequirements, input, options);
  }

  extractDesignSpec(
    input: ExtractDesignSpecInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedDesignSpec> {
    return this.runStructured(structuredReasoningSpecs.extractDesignSpec, input, options);
  }

  extractTestPlan(
    input: ExtractTestPlanInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedTestPlan> {
    return this.runStructured(structuredReasoningSpecs.extractTestPlan, input, options);
  }

  decomposeIntoTasks(
    input: DecomposeIntoTasksInput,
    options?: ReasoningCallOptions
  ): Promise<DecomposedTaskPlan> {
    return this.runStructured(structuredReasoningSpecs.decomposeIntoTasks, input, options);
  }

  /**
   * Advisory text delegation: the SDK agent has no tools here, so it can only
   * answer. R5: the start is marked inside `runCursorSdkText` right before the
   * prompt leaves the process; an earlier failure is pre-start.
   */
  delegateTask(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string> {
    return runStartReportingDelegation(() =>
      this.complete(
        STRUCTURED_REASONING_SYSTEM_PROMPT,
        [context ? `Context: ${context}` : '', `Task: ${instruction}`].filter(Boolean).join('\n\n'),
        { signal: options?.signal, model: options?.model, contextMode: options?.context_mode }
      )
    );
  }

  async prompt(prompt: string, options?: ReasoningCallOptions): Promise<string> {
    return this.complete(
      'You are a focused reasoning sub-agent. Return a concise, factual answer.',
      prompt,
      { signal: options?.signal, model: options?.model, contextMode: options?.context_mode }
    );
  }

  private complete(
    systemPrompt: string,
    userPrompt: string,
    options?: {
      signal?: AbortSignal;
      model?: string;
      shapeHint?: string;
      contextMode?: 'fresh' | 'continue';
    }
  ): Promise<string> {
    const hint = options?.shapeHint?.trim()
      ? `\n\nRespond with exactly this JSON shape (top-level keys, nesting, and field names must match): ${options.shapeHint.trim()}`
      : '';
    // Output exit: the answer and any error text are redacted.
    return withRedactedProviderOutput(() =>
      runCursorSdkText(
        {
          systemPrompt,
          userPrompt: `${userPrompt.trim()}${hint}`,
          model: options?.model?.trim() || this.model,
          timeoutMs: this.timeoutMs,
          nativeSystemPrompt: this.nativeSystemPrompt,
          ...(options?.contextMode
            ? { contextMode: options.contextMode, session: this.session }
            : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
        this.queryDeps
      )
    );
  }
}

/** SYNC probe — a Cursor API key must resolve; no live LLM call. */
export function probeCursorSdkAvailability(
  env: NodeJS.ProcessEnv = process.env
): CursorSdkAvailability {
  try {
    return resolveCursorSdkApiKey(env)
      ? { available: true }
      : {
          available: false,
          reason:
            'CURSOR_API_KEY is not configured (run `pnpm kyberion secret introduce cursor API_KEY`)',
        };
  } catch (err: unknown) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function buildCursorSdkOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CursorSdkReasoningBackendOptions {
  const model = getRegisteredEnvText('KYBERION_CURSOR_SDK_MODEL', { env })?.trim();
  const native = getRegisteredEnvText('KYBERION_CURSOR_SDK_NATIVE_SYSTEM_PROMPT', { env })
    ?.trim()
    .toLowerCase();
  const ttl = getRegisteredEnvText('KYBERION_CURSOR_SDK_SESSION_IDLE_TTL_MS', { env })?.trim();
  const ttlMs = ttl ? Number(ttl) : undefined;
  return {
    ...(model ? { model } : {}),
    ...(ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs >= 0
      ? { sessionIdleTtlMs: ttlMs }
      : {}),
    ...(native === '1' || native === 'true' ? { nativeSystemPrompt: true } : {}),
  };
}

export function buildCursorSdkBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  model?: string,
  probe: (env: NodeJS.ProcessEnv) => CursorSdkAvailability = probeCursorSdkAvailability
): CursorSdkReasoningBackend | null {
  const availability = probe(env);
  if (!availability.available) {
    logger.warn(
      `[cursor-sdk] backend unavailable — ${availability.reason ?? 'no Cursor API key'} | next: pnpm kyberion secret introduce cursor API_KEY | evidence: cursor-sdk`
    );
    return null;
  }
  const options = { ...buildCursorSdkOptionsFromEnv(env), ...(model ? { model } : {}) };
  const backend = new CursorSdkReasoningBackend(options);
  logger.debug(`[cursor-sdk] backend ready (model=${options.model ?? CURSOR_SDK_DEFAULT_MODEL})`);
  return backend;
}
