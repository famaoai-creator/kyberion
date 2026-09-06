/**
 * Reasoning Backend Contract — where LLM reasoning actually runs.
 *
 * Implements the contract layer of CONCEPT_INTEGRATION_BACKLOG P2-1.
 * Per the CLI harness coordination model, Kyberion owns the contract
 * (what to produce) but delegates the *reasoning* to an external provider
 * runtime or, in limited cases, an in-process LLM client. This module exposes
 * a small abstract surface so call sites (decision-ops, compilers, workflows)
 * never embed a specific reasoning implementation.
 *
 * Default backend is `stub` — deterministic, offline, returns structured
 * placeholders and logs a warning. Real backends (e.g. a host-CLI
 * adapter) are registered via `registerReasoningBackend`.
 */

import { logger } from './core.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';
import { assertOperationPolicy, currentDelegationDepth } from './operation-policy-gate.js';
import type { A2ATaskContract, PlanningPacket, TaskResultBlock } from './channel-surface-types.js';
import { slugify } from './foundation/text.js';
import { frameUntrustedInput } from './untrusted-input-framing.js';
import { createGapRecorder, type GapPhaseSample } from './gap-phase.js';
import { parseStructuredJson } from './structured-reasoning.js';
import {
  resolveStructuredOutputSchema,
  type ProcedureRankingResult,
  type StructuredOutputSchemaRef,
} from './structured-output-contracts.js';
import {
  listDemotedProviders,
  reportProviderHealthy,
  getProviderHealthDemotionTtlMs,
  reportProviderTemporarilyUnhealthy,
} from './provider-health-registry.js';
import { enforceSpendGuardForReasoning } from './spend-guard.js';
import { metrics } from './metrics.js';
import { findMissionPath } from './path-resolver.js';
import { z } from 'zod';
import {
  assertReasoningEgressAllowed,
  assertReasoningEgressAllowedAtEndpoint,
} from './reasoning-egress-scope.js';
import { classifyReasoningFailure, reasoningFailureMessage } from './reasoning-failure-taxonomy.js';
import { appendReasoningFailoverEvent, markReasoningFailover } from './reasoning-failover.js';
// Existing reasoning/delegation cycle is tracked by check:module-boundaries baseline.
// eslint-disable-next-line import/no-cycle -- baseline until the delegation seam is split
import { createDelegationHandle, type DelegationHandle } from './delegated-task-observability.js';
import type { NativeSubagentAdopter } from './native-subagent-adopter.js';
import { AdvisoryPolicyViolation } from './ce-adoption.js';
import { assertDistillationTextEgress } from './frame-redaction.js';
import { appendPromptVisibilityRecord } from './prompt-visibility-ledger.js';
import { resolveConstrainedSampling } from './backend-capability-profile.js';
import {
  appendDeferredToolAnnouncement,
  planDeferredToolLoading,
} from './prompt-cache-discipline.js';
import { getRegisteredEnvText } from './foundation/env.js';
import {
  DELEGATION_SUMMARY_MIN_CHARS,
  delegationSummaryRetryEnabled,
  buildDelegationSummaryContinuationPrompt,
  STRUCTURED_DELEGATION_PROMPT_HEADER,
} from './reasoning-delegation-policy.js';
export {
  DELEGATION_SUMMARY_MIN_CHARS,
  STRUCTURED_DELEGATION_PROMPT_HEADER,
  delegationSummaryRetryEnabled,
  buildDelegationSummaryContinuationPrompt,
} from './reasoning-delegation-policy.js';
import {
  DEFAULT_IN_PLACE_RETRIES,
  resolveDemotionRetryAfterMs,
  resolveInPlaceRetryCount,
  resolveInPlaceRetryDelayMs,
  sleep,
  throwIfReasoningAborted,
} from './reasoning-retry-policy.js';
import type {
  DivergeHypothesisInput,
  HypothesisSketch,
  CritiqueInput,
  CritiqueResult,
  PersonaSynthesisInput,
  SynthesizedPersona,
  BranchForkInput,
  ForkedBranch,
  SimulationInput,
  SimulationResult,
  ExtractRequirementsInput,
  ExtractedRequirements,
  ExtractDesignSpecInput,
  ExtractedDesignSpec,
  ExtractTestPlanInput,
  ExtractedTestPlan,
  DecomposeIntoTasksInput,
  DecomposedTaskPlan,
  ToolDefinition,
  GenerateWithToolsResult,
  ReasoningPromptVisibilityContext,
  ReasoningCallOptions,
  ReasoningTextStream,
  StructuredDelegationOptions,
  BestOfDelegationOptions,
  PeerAdviceInput,
  PeerAdviceResult,
  ReasoningBackend,
  ReasoningImageAttachment,
  ReasoningBackendCandidate,
  ReasoningFailoverPolicy,
} from './reasoning-backend-contracts.js';
export * from './reasoning-backend-contracts.js';

function shouldRetryShortDelegationSummary(input: {
  instruction: string;
  result: string;
  servedBackendName: string;
}): boolean {
  if (!delegationSummaryRetryEnabled()) return false;
  // The stub backend returns short deterministic placeholders by design —
  // retrying would only duplicate them and destabilize hermetic tests.
  if (input.servedBackendName === 'stub') return false;
  if (input.instruction.startsWith(STRUCTURED_DELEGATION_PROMPT_HEADER)) return false;
  return input.result.trim().length < DELEGATION_SUMMARY_MIN_CHARS;
}

function normalizeProviderName(value?: string): string | null {
  const provider = String(value || '')
    .trim()
    .toLowerCase();
  return provider || null;
}

function candidateLabel(candidate: ReasoningBackendCandidate): string {
  return candidate.label || candidate.backend.name || candidate.provider || 'unknown';
}

function recordReasoningPromptVisibility(
  content: string,
  options: ReasoningCallOptions | undefined,
  defaultForm: string
): void {
  const visibility = options?.prompt_visibility || inferAmbientPromptVisibility();
  if (!visibility) return;
  appendPromptVisibilityRecord({
    missionPath: visibility.missionPath,
    missionId: visibility.missionId,
    source: visibility.source || 'reasoning-backend',
    form: visibility.form || defaultForm,
    content,
    ...(visibility.contextPackId ? { contextPackId: visibility.contextPackId } : {}),
    ...(visibility.taskId ? { taskId: visibility.taskId } : {}),
    knowledgeRefs: visibility.knowledgeRefs,
  });
}

/**
 * DH-06: direct reasoning callers may not have a pipeline context object, but
 * mission-controller entry points still expose a validated mission id. Use
 * that id only to locate an existing mission directory; never invent a
 * ledger path from an arbitrary environment value. Explicit visibility wins
 * at the call site and can carry task/context-pack/knowledge references.
 */
function inferAmbientPromptVisibility(): ReasoningPromptVisibilityContext | undefined {
  const missionId = String(getRegisteredEnvText('MISSION_ID') || '').trim();
  if (!missionId) return undefined;
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return undefined;
  const knowledgeRefs = String(getRegisteredEnvText('KYBERION_KNOWLEDGE_REFS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const taskId = String(getRegisteredEnvText('KYBERION_TASK_ID') || '').trim();
  const contextPackId = String(getRegisteredEnvText('KYBERION_CONTEXT_PACK_ID') || '').trim();
  return {
    missionPath,
    missionId,
    ...(taskId ? { taskId } : {}),
    ...(contextPackId ? { contextPackId } : {}),
    knowledgeRefs,
    source: 'reasoning-backend:ambient-mission',
    form: 'reasoning_ambient',
  };
}

// ---------------------------------------------------------------------------
// XP-05: failover switch surfacing + serving provenance.
//
// "Switch" means: the primary (first) candidate in the chain did not serve
// the call and a later candidate did. Every switch is (a) appended to a
// durable JSONL event log and (b) logged once per (from,to) pair per process
// — long sessions that keep hitting the same dead primary must not spam the
// log. `getLastServedReasoningMode()` is the minimal provenance accessor:
// callers that persist a task_result can read it right after the call
// resolves and stamp `provenance` on the result (see channel-surface-types.ts
// TaskResultBlock.provenance). Wiring that stamp into the mission worker is
// tracked as follow-up — see XP-05 report.
// ---------------------------------------------------------------------------

export interface LastServedReasoningMode {
  mode: string;
  provider?: string;
  failover: boolean;
}

let lastServedReasoningMode: LastServedReasoningMode | null = null;
const warnedFailoverPairs = new Set<string>();

/** Which candidate actually served the most recent failover-chain call. */
export function getLastServedReasoningMode(): LastServedReasoningMode | null {
  return lastServedReasoningMode;
}

/** Test-only: clear in-process failover provenance/throttle state. */
export function resetReasoningFailoverTracking(): void {
  lastServedReasoningMode = null;
  warnedFailoverPairs.clear();
}

/**
 * Called once a candidate has successfully served a failover-chain call.
 * Updates the provenance accessor unconditionally, and — only when the
 * serving candidate is not the primary (chain[0]) — records the switch
 * (JSONL event + marker file, both best-effort) and warns once per
 * (from,to) pair per process.
 */
function recordCandidateServed(
  operation: string,
  primary: ReasoningBackendCandidate,
  serving: ReasoningBackendCandidate,
  errors: string[]
): void {
  const toMode = candidateLabel(serving);
  const toProvider = normalizeProviderName(serving.provider) || undefined;
  const isFailover = serving !== primary;
  lastServedReasoningMode = { mode: toMode, provider: toProvider, failover: isFailover };
  if (!isFailover) return;

  const fromMode = candidateLabel(primary);
  const fromProvider = normalizeProviderName(primary.provider) || undefined;
  const errorSummary = errors[0] || 'unknown failure';

  appendReasoningFailoverEvent({
    from_mode: fromMode,
    to_mode: toMode,
    provider_from: fromProvider,
    provider_to: toProvider,
    method: operation,
    error_summary: errorSummary,
  });
  markReasoningFailover({
    from_mode: fromMode,
    to_mode: toMode,
    provider_from: fromProvider,
    provider_to: toProvider,
    method: operation,
  });

  const pairKey = `${fromMode}->${toMode}`;
  if (!warnedFailoverPairs.has(pairKey)) {
    warnedFailoverPairs.add(pairKey);
    logger.warn(
      `[reasoning-backend:failover] provider failover active: ${fromMode} -> ${toMode} (${operation}); ` +
        `primary failure: ${errorSummary}`
    );
  }
}

export class FailoverReasoningBackend implements ReasoningBackend {
  readonly name: string;
  private readonly candidates: ReasoningBackendCandidate[];
  private readonly failoverPolicy: ReasoningFailoverPolicy;
  /** QM-06: label of the candidate that served the previous call. */
  private lastServedLabel: string | null = null;

  constructor(
    candidates: ReasoningBackendCandidate[],
    failoverPolicy?: Partial<ReasoningFailoverPolicy>
  ) {
    this.candidates = candidates.filter((candidate) => Boolean(candidate.backend));
    this.failoverPolicy = {
      max_attempts: Math.max(
        1,
        Math.floor((failoverPolicy?.max_attempts ?? this.candidates.length) || 1)
      ),
      max_in_place_retries: Math.max(
        0,
        Math.floor(failoverPolicy?.max_in_place_retries ?? DEFAULT_IN_PLACE_RETRIES)
      ),
      on_unsupported_parameter: failoverPolicy?.on_unsupported_parameter ?? 'reject',
    };
    this.name = this.candidates[0]?.backend.name || 'failover';
    if (this.candidates.some((candidate) => candidate.backend.promptWithImages)) {
      this.promptWithImages = (prompt, images, options) =>
        this.promptWithImagesAcrossCandidates(prompt, images, options);
    }
  }

  getRuntimeInstructions(options?: ReasoningCallOptions): string[] {
    return this.candidates[0]?.backend.getRuntimeInstructions?.(options) || [];
  }

  getRuntimeProviderName(options?: ReasoningCallOptions): string {
    return this.candidates[0]?.backend.getRuntimeProviderName?.(options) || this.name;
  }

  selectConsultationCandidate(
    input: {
      preferredProvider?: string;
      preferredLabel?: string;
    } = {}
  ): ReasoningBackendCandidate | null {
    const primary = this.candidates[0];
    if (!primary) return null;
    const primaryKey = candidateLabel(primary);
    const preferredProvider = normalizeProviderName(input.preferredProvider);
    const preferredLabel = String(input.preferredLabel || '')
      .trim()
      .toLowerCase();
    const peers = this.candidates.slice(1);
    const matches = peers.filter((candidate) => {
      const candidateProvider = normalizeProviderName(candidate.provider);
      const candidateKey = candidateLabel(candidate).toLowerCase();
      if (candidateKey === primaryKey.toLowerCase()) return false;
      if (preferredProvider && candidateProvider && candidateProvider !== preferredProvider) {
        return false;
      }
      if (preferredLabel && candidateKey !== preferredLabel) return false;
      return true;
    });
    return matches[0] || peers[0] || null;
  }

  /** Expose the primary provider's native subagent surface to the dispatcher. */
  getNativeSubagentAdopter(): NativeSubagentAdopter | null {
    return this.candidates[0]?.backend.getNativeSubagentAdopter?.() ?? null;
  }

  requiresNativeSubagent(): boolean {
    return this.candidates[0]?.backend.requiresNativeSubagent?.() ?? false;
  }

  /**
   * QM-06 (qm harness-router pattern): when the serving candidate changes
   * between calls, the INCOMING backend is reset BEFORE it is invoked (so
   * the first post-switch call can never be served on a stale provider
   * session from an earlier stint) and the OUTGOING backend is reset after
   * the switch is confirmed. Best-effort — a reset failure never affects the
   * served result.
   */
  private async resetBackendSession(label: string, phase: 'incoming' | 'outgoing'): Promise<void> {
    const candidate = this.candidates.find((entry) => candidateLabel(entry) === label);
    const reset = candidate?.backend.resetSession?.bind(candidate.backend);
    if (!reset) return;
    try {
      await reset();
    } catch (error) {
      logger.warn(
        `[QM-06] resetSession (${phase}) on ${label} around failover switch failed (ignored): ${error}`
      );
    }
  }

  private async runWithFailover<T>(
    operation: string,
    invoke: (backend: ReasoningBackend) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    throwIfReasoningAborted(signal);
    // OP-01: the spend cap is real control, not prompt text. Warn posture
    // logs/alerts and proceeds; block posture throws SpendCapExceededError
    // before any provider is invoked.
    enforceSpendGuardForReasoning();
    // SA-05: delegation policy — the hop being created is depth+1, so the
    // delegation-depth-limit rule can actually fire on runaway chains.
    if (operation === 'delegateTask') {
      assertOperationPolicy({
        operation: 'reasoning_delegation',
        context: { delegation_depth: currentDelegationDepth() + 1 },
      });
    }
    const skippedProviders = new Set(listDemotedProviders());
    const errors: string[] = [];

    for (const candidate of this.candidates.slice(0, this.failoverPolicy.max_attempts)) {
      const provider = normalizeProviderName(candidate.provider);
      if (provider && skippedProviders.has(provider)) continue;
      const label = candidateLabel(candidate);
      const isSwitch = this.lastServedLabel !== null && label !== this.lastServedLabel;
      if (isSwitch) await this.resetBackendSession(label, 'incoming');
      const attempt = await this.attemptCandidateWithRetries(
        operation,
        candidate,
        provider,
        invoke,
        signal
      );
      if (attempt.ok === false) {
        errors.push(`${label}: ${attempt.message}`);
        if (attempt.stop) break;
        continue;
      }
      if (this.candidates[0])
        recordCandidateServed(operation, this.candidates[0], candidate, errors);
      if (isSwitch && this.lastServedLabel) {
        await this.resetBackendSession(this.lastServedLabel, 'outgoing');
      }
      this.lastServedLabel = label;
      return attempt.result;
    }

    throw new Error(
      `[reasoning-backend:failover] ${operation} failed across ${errors.length} candidate(s): ${errors.join(' | ')}`
    );
  }

  /**
   * Run one candidate with OH-03 in-place retries: transient failures
   * (429/5xx/529) back off and retry on the same provider up to the configured
   * cap; anything else (or retry exhaustion) demotes the provider and reports
   * the failure so the caller can move to the next candidate.
   */
  private async attemptCandidateWithRetries<T>(
    operation: string,
    candidate: ReasoningBackendCandidate,
    provider: string | undefined,
    invoke: (backend: ReasoningBackend) => Promise<T>,
    signal?: AbortSignal
  ): Promise<{ ok: true; result: T } | { ok: false; message: string; stop: boolean }> {
    const maxInPlaceRetries = resolveInPlaceRetryCount(this.failoverPolicy.max_in_place_retries);
    for (let retryAttempt = 0; ; retryAttempt++) {
      try {
        throwIfReasoningAborted(signal);
        const endpoint = (candidate.backend as ReasoningBackend & { egressEndpoint?: string })
          .egressEndpoint;
        if (endpoint) assertReasoningEgressAllowedAtEndpoint(candidate.backend.name, endpoint);
        else assertReasoningEgressAllowed(candidate.backend.name);
        const result = await invoke(candidate.backend);
        if (provider) reportProviderHealthy(provider);
        try {
          metrics.record('reasoning:route-served', 0, 'success', {
            operation,
            provider: provider || undefined,
            candidate: candidateLabel(candidate),
          });
        } catch {
          // Metrics must never change reasoning behavior.
        }
        return { ok: true, result };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = reasoningFailureMessage(error);
        const classification = classifyReasoningFailure(error);
        if (classification.retryable && retryAttempt < maxInPlaceRetries) {
          const nextAttempt = retryAttempt + 1;
          const delayMs = resolveInPlaceRetryDelayMs(error, nextAttempt);
          logger.warn(
            `[reasoning-backend:retry] ${operation} transient failure on ${candidateLabel(candidate)}${provider ? ` (${provider})` : ''}; retry ${nextAttempt}/${maxInPlaceRetries} in ${delayMs}ms: ${message}`
          );
          try {
            metrics.record('reasoning:in-place-retry', delayMs, 'success', {
              operation,
              provider: provider || undefined,
              candidate: candidateLabel(candidate),
              retry_attempt: nextAttempt,
              retry_delay_ms: delayMs,
              error: message,
            });
          } catch {
            // Metrics are best-effort and must not alter retry behavior.
          }
          await sleep(delayMs);
          throwIfReasoningAborted(signal);
          continue;
        }

        logger.warn(
          `[reasoning-backend:failover] ${operation} failed on ${candidateLabel(candidate)}${provider ? ` (${provider})` : ''}; class=${classification.class}; ${classification.allowFailover ? `demoting for ${getProviderHealthDemotionTtlMs()}ms` : 'stopping without fallback'}: ${message}`
        );
        try {
          metrics.record('reasoning:route-failure', 0, 'error', {
            operation,
            provider: provider || undefined,
            candidate: candidateLabel(candidate),
            failure_class: classification.class,
          });
        } catch {
          // Metrics must never change failure handling.
        }
        if (provider && classification.demoteProvider) {
          reportProviderTemporarilyUnhealthy(provider, {
            reason: `${operation}:${message}`,
            retryAfterMs: resolveDemotionRetryAfterMs(message),
          });
        }
        return {
          ok: false,
          message: `[${classification.class}] ${message}`,
          stop: !classification.allowFailover,
        };
      }
    }
  }

  divergePersonas(
    input: DivergeHypothesisInput,
    options?: ReasoningCallOptions
  ): Promise<HypothesisSketch[]> {
    return this.runWithFailover('divergePersonas', (backend) =>
      backend.divergePersonas(input, options)
    );
  }

  crossCritique(input: CritiqueInput, options?: ReasoningCallOptions): Promise<CritiqueResult> {
    return this.runWithFailover('crossCritique', (backend) =>
      backend.crossCritique(input, options)
    );
  }

  synthesizePersona(
    input: PersonaSynthesisInput,
    options?: ReasoningCallOptions
  ): Promise<SynthesizedPersona> {
    return this.runWithFailover('synthesizePersona', (backend) =>
      backend.synthesizePersona(input, options)
    );
  }

  forkBranches(input: BranchForkInput, options?: ReasoningCallOptions): Promise<ForkedBranch[]> {
    return this.runWithFailover('forkBranches', (backend) => backend.forkBranches(input, options));
  }

  simulateBranches(
    input: SimulationInput,
    options?: ReasoningCallOptions
  ): Promise<SimulationResult> {
    return this.runWithFailover('simulateBranches', (backend) =>
      backend.simulateBranches(input, options)
    );
  }

  extractRequirements(
    input: ExtractRequirementsInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedRequirements> {
    return this.runWithFailover('extractRequirements', (backend) =>
      backend.extractRequirements(input, options)
    );
  }

  extractDesignSpec(
    input: ExtractDesignSpecInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedDesignSpec> {
    return this.runWithFailover('extractDesignSpec', (backend) =>
      backend.extractDesignSpec(input, options)
    );
  }

  extractTestPlan(
    input: ExtractTestPlanInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedTestPlan> {
    return this.runWithFailover('extractTestPlan', (backend) =>
      backend.extractTestPlan(input, options)
    );
  }

  decomposeIntoTasks(
    input: DecomposeIntoTasksInput,
    options?: ReasoningCallOptions
  ): Promise<DecomposedTaskPlan> {
    return this.runWithFailover('decomposeIntoTasks', (backend) =>
      backend.decomposeIntoTasks(input, options)
    );
  }

  async delegateTask(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string> {
    assertDistillationTextEgress([instruction, context].filter(Boolean).join('\n\n'));
    recordReasoningPromptVisibility(
      [instruction, context].filter(Boolean).join('\n\n'),
      options,
      'reasoning_delegate_task'
    );
    let servedBackendName = '';
    const first = await this.runWithFailover(
      'delegateTask',
      (backend) => {
        servedBackendName = backend.name;
        return backend.delegateTask(instruction, context, options);
      },
      options?.signal
    );
    if (!shouldRetryShortDelegationSummary({ instruction, result: first, servedBackendName })) {
      return first;
    }
    logger.warn(
      `[reasoning-backend] delegation report too brief (${first.trim().length} chars < ${DELEGATION_SUMMARY_MIN_CHARS}); requesting one continuation`
    );
    // KC-06: exactly one continuation — the second result passes through as-is.
    const continuationPrompt = buildDelegationSummaryContinuationPrompt(instruction, first);
    recordReasoningPromptVisibility(
      [continuationPrompt, context].filter(Boolean).join('\n\n'),
      options,
      'reasoning_delegate_task_continuation'
    );
    return this.runWithFailover(
      'delegateTask',
      (backend) => {
        servedBackendName = backend.name;
        assertDistillationTextEgress([instruction, first, context].filter(Boolean).join('\n\n'));
        return backend.delegateTask(continuationPrompt, context, options);
      },
      options?.signal
    );
  }

  delegateTaskHandle(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): DelegationHandle {
    return createDelegationHandle({
      instruction,
      ...(context ? { context } : {}),
      backendName: this.name,
      ...(options?.continuable ? { continuable: true } : {}),
      execute: (signal) =>
        this.delegateTask(instruction, context, { ...options, ...(signal ? { signal } : {}) }),
    });
  }

  prompt(prompt: string, options?: ReasoningCallOptions): Promise<string> {
    assertDistillationTextEgress(prompt);
    recordReasoningPromptVisibility(prompt, options, 'reasoning_prompt');
    return this.runWithFailover(
      'prompt',
      (backend) => backend.prompt(prompt, options),
      options?.signal
    );
  }

  async *streamPrompt(prompt: string, options?: ReasoningCallOptions): ReasoningTextStream {
    assertDistillationTextEgress(prompt);
    throwIfReasoningAborted(options?.signal);
    enforceSpendGuardForReasoning();
    const candidates = this.candidates.slice(0, this.failoverPolicy.max_attempts);
    const demotedProviders = new Set(listDemotedProviders());
    for (const candidate of candidates) {
      const provider = normalizeProviderName(candidate.provider);
      if (provider && demotedProviders.has(provider)) continue;
      const stream = candidate.backend.streamPrompt;
      if (!stream) continue;
      let yielded = false;
      try {
        throwIfReasoningAborted(options?.signal);
        const endpoint = (candidate.backend as ReasoningBackend & { egressEndpoint?: string })
          .egressEndpoint;
        if (endpoint) assertReasoningEgressAllowedAtEndpoint(candidate.backend.name, endpoint);
        else assertReasoningEgressAllowed(candidate.backend.name);
        recordReasoningPromptVisibility(prompt, options, 'reasoning_stream_prompt');
        for await (const delta of stream.call(candidate.backend, prompt, options)) {
          yielded = true;
          yield delta;
        }
        if (yielded) return;
      } catch (error) {
        // Once output has reached the caller, replaying on another provider
        // would duplicate speech. Before the first delta, try the next route.
        if (yielded) throw error;
        logger.warn(
          `[reasoning-backend] streaming candidate ${candidateLabel(candidate)} failed before output: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const completed = await this.prompt(prompt, options);
    if (completed) yield completed;
  }

  async generateWithTools(
    prompt: string,
    tools: ToolDefinition[],
    options?: ReasoningCallOptions
  ): Promise<GenerateWithToolsResult> {
    assertDistillationTextEgress(prompt);
    const toolPlan = planDeferredToolLoading(tools, {
      ...(options?.role ? { role: options.role } : {}),
      ...(options?.deferred_tool_names ? { deferredToolNames: options.deferred_tool_names } : {}),
      ...(options?.deferred_tool_definitions
        ? { deferredTools: options.deferred_tool_definitions }
        : {}),
    });
    const effectivePrompt = appendDeferredToolAnnouncement(prompt, toolPlan.announcement);
    recordReasoningPromptVisibility(
      `${effectivePrompt}\n\n[tool definitions]\n${JSON.stringify(toolPlan.active)}`,
      options,
      'reasoning_generate_with_tools'
    );
    const skippedProviders = new Set(listDemotedProviders());
    const errors: string[] = [];
    let primaryCandidate: ReasoningBackendCandidate | undefined;

    for (const candidate of this.candidates) {
      const provider = normalizeProviderName(candidate.provider);
      if (provider && skippedProviders.has(provider)) continue;
      if (!candidate.backend.generateWithTools) continue;
      if (!primaryCandidate) primaryCandidate = candidate;
      const attempt = await this.attemptCandidateWithRetries(
        'generateWithTools',
        candidate,
        provider,
        (backend) =>
          backend.generateWithTools!(
            effectivePrompt,
            toolPlan.active,
            toolPlan.deferred.length > 0
              ? { ...(options || {}), deferred_tool_definitions: toolPlan.deferred }
              : options
          )
      );
      if (attempt.ok === false) {
        errors.push(`${candidateLabel(candidate)}: ${attempt.message}`);
        if (attempt.stop) break;
        continue;
      }
      recordCandidateServed('generateWithTools', primaryCandidate, candidate, errors);
      if (options?.advisory && (attempt.result.toolCalls?.length ?? 0) > 0) {
        throw new AdvisoryPolicyViolation();
      }
      return attempt.result;
    }

    throw new Error(
      `[reasoning-backend:failover] generateWithTools failed across ${errors.length} candidate(s): ${errors.join(' | ')}`
    );
  }

  /**
   * Assigned in the constructor, and only when a candidate can actually see
   * images, so `backendSupportsVision` on the wrapper answers truthfully
   * instead of promising a capability none of the candidates has.
   */
  promptWithImages?: (
    prompt: string,
    images: ReasoningImageAttachment[],
    options?: ReasoningCallOptions
  ) => Promise<string>;

  private async promptWithImagesAcrossCandidates(
    prompt: string,
    images: ReasoningImageAttachment[],
    options?: ReasoningCallOptions
  ): Promise<string> {
    assertDistillationTextEgress(prompt);
    recordReasoningPromptVisibility(
      `${prompt}\n\n[image attachments]\n${JSON.stringify(
        images.map(({ path: imagePath, media_type }) => ({ path: imagePath, media_type }))
      )}`,
      options,
      'reasoning_prompt_with_images'
    );
    const skippedProviders = new Set(listDemotedProviders());
    const errors: string[] = [];
    let primaryCandidate: ReasoningBackendCandidate | undefined;

    for (const candidate of this.candidates) {
      const provider = normalizeProviderName(candidate.provider);
      if (provider && skippedProviders.has(provider)) continue;
      // Skipping a text-only candidate matters more here than elsewhere:
      // failing over to one would drop the images and return an answer about
      // pictures the model never received.
      if (!candidate.backend.promptWithImages) continue;
      if (!primaryCandidate) primaryCandidate = candidate;
      const attempt = await this.attemptCandidateWithRetries(
        'promptWithImages',
        candidate,
        provider,
        (backend) => backend.promptWithImages!(prompt, images, options)
      );
      if (attempt.ok === false) {
        errors.push(`${candidateLabel(candidate)}: ${attempt.message}`);
        if (attempt.stop) break;
        continue;
      }
      recordCandidateServed('promptWithImages', primaryCandidate, candidate, errors);
      return attempt.result;
    }

    throw new Error(
      `[reasoning-backend:failover] promptWithImages failed across ${errors.length} vision-capable candidate(s): ${errors.join(' | ')}`
    );
  }
}

/** Dispatches a call to a role-specific failover chain while preserving the
 * legacy default chain for callers that do not provide a role. */
export class RoleAwareReasoningBackend implements ReasoningBackend {
  readonly name: string;
  private readonly defaultBackend: ReasoningBackend;
  private readonly roleBackends: Map<string, ReasoningBackend>;
  private readonly profileBackends: Map<string, ReasoningBackend>;

  constructor(
    defaultBackend: ReasoningBackend,
    roleBackends: Map<string, ReasoningBackend> = new Map(),
    profileBackends: Map<string, ReasoningBackend> = new Map()
  ) {
    this.defaultBackend = defaultBackend;
    this.roleBackends = roleBackends;
    this.profileBackends = profileBackends;
    // Preserve the legacy observable backend name for existing diagnostics and
    // consumers; role dispatch is an internal routing concern.
    this.name = defaultBackend.name;
  }

  private pick(options?: ReasoningCallOptions): ReasoningBackend {
    const profile = options?.route_profile?.trim();
    if (profile) return this.profileBackends.get(profile) || this.defaultBackend;
    const role = options?.role
      ?.trim()
      .toLowerCase()
      .replace(/[-\s]+/g, '_');
    return (role && this.roleBackends.get(role)) || this.defaultBackend;
  }

  getRuntimeInstructions(options?: ReasoningCallOptions): string[] {
    return this.pick(options).getRuntimeInstructions?.(options) || [];
  }

  getRuntimeProviderName(options?: ReasoningCallOptions): string {
    return this.pick(options).getRuntimeProviderName?.(options) || this.pick(options).name;
  }

  getNativeSubagentAdopter(): NativeSubagentAdopter | null {
    return this.defaultBackend.getNativeSubagentAdopter?.() ?? null;
  }

  requiresNativeSubagent(): boolean {
    return this.defaultBackend.requiresNativeSubagent?.() ?? false;
  }
  /** QM-06: forward session resets to every wrapped backend, best-effort. */
  async resetSession(): Promise<void> {
    const backends = new Set<ReasoningBackend>([
      this.defaultBackend,
      ...this.roleBackends.values(),
      ...this.profileBackends.values(),
    ]);
    for (const backend of backends) {
      try {
        await backend.resetSession?.();
      } catch (error) {
        logger.warn(`[QM-06] resetSession on wrapped backend ${backend.name} failed: ${error}`);
      }
    }
  }
  divergePersonas(input: DivergeHypothesisInput, options?: ReasoningCallOptions) {
    return this.pick(options).divergePersonas(input, options);
  }
  crossCritique(input: CritiqueInput, options?: ReasoningCallOptions) {
    return this.pick(options).crossCritique(input, options);
  }
  synthesizePersona(input: PersonaSynthesisInput, options?: ReasoningCallOptions) {
    return this.pick(options).synthesizePersona(input, options);
  }
  forkBranches(input: BranchForkInput, options?: ReasoningCallOptions) {
    return this.pick(options).forkBranches(input, options);
  }
  simulateBranches(input: SimulationInput, options?: ReasoningCallOptions) {
    return this.pick(options).simulateBranches(input, options);
  }
  extractRequirements(input: ExtractRequirementsInput, options?: ReasoningCallOptions) {
    return this.pick(options).extractRequirements(input, options);
  }
  extractDesignSpec(input: ExtractDesignSpecInput, options?: ReasoningCallOptions) {
    return this.pick(options).extractDesignSpec(input, options);
  }
  extractTestPlan(input: ExtractTestPlanInput, options?: ReasoningCallOptions) {
    return this.pick(options).extractTestPlan(input, options);
  }
  decomposeIntoTasks(input: DecomposeIntoTasksInput, options?: ReasoningCallOptions) {
    return this.pick(options).decomposeIntoTasks(input, options);
  }
  delegateTask(instruction: string, context?: string, options?: ReasoningCallOptions) {
    return this.pick(options).delegateTask(instruction, context, options);
  }
  delegateTaskHandle(instruction: string, context?: string, options?: ReasoningCallOptions) {
    const backend = this.pick(options);
    return backend.delegateTaskHandle
      ? backend.delegateTaskHandle(instruction, context, options)
      : createDelegationHandle({
          instruction,
          ...(context ? { context } : {}),
          backendName: backend.name,
          ...(options?.continuable ? { continuable: true } : {}),
          execute: (signal) =>
            backend.delegateTask(instruction, context, {
              ...options,
              ...(signal ? { signal } : {}),
            }),
        });
  }
  prompt(prompt: string, options?: ReasoningCallOptions) {
    return this.pick(options).prompt(prompt, options);
  }
  streamPrompt(prompt: string, options?: ReasoningCallOptions): ReasoningTextStream {
    const backend = this.pick(options);
    if (backend.streamPrompt) return backend.streamPrompt(prompt, options);
    return (async function* fallback(): AsyncGenerator<string> {
      const text = await backend.prompt(prompt, options);
      if (text) yield text;
    })();
  }
  generateWithTools(prompt: string, tools: ToolDefinition[], options?: ReasoningCallOptions) {
    const backend = this.pick(options);
    return backend.generateWithTools
      ? backend.generateWithTools(prompt, tools, options)
      : Promise.reject(new Error(`Role ${options?.role || 'default'} has no tool-capable backend`));
  }
  promptWithImages(
    prompt: string,
    images: ReasoningImageAttachment[],
    options?: ReasoningCallOptions
  ) {
    const backend = this.pick(options);
    if (!backend.promptWithImages)
      return Promise.reject(
        new Error(`Role ${options?.role || 'default'} does not support vision`)
      );
    return backend.promptWithImages(prompt, images, options);
  }
}

export function buildFailoverReasoningBackend(
  candidates: ReasoningBackendCandidate[],
  failoverPolicy?: Partial<ReasoningFailoverPolicy>
): ReasoningBackend {
  return new FailoverReasoningBackend(candidates, failoverPolicy);
}

export function buildRoleAwareReasoningBackend(
  defaultBackend: ReasoningBackend,
  roleBackends: Map<string, ReasoningBackend>,
  profileBackends: Map<string, ReasoningBackend> = new Map()
): ReasoningBackend {
  return new RoleAwareReasoningBackend(defaultBackend, roleBackends, profileBackends);
}

export function delegateStructured(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  instruction: string,
  schema: 'planning_packet',
  options?: StructuredDelegationOptions
): Promise<PlanningPacket>;
export function delegateStructured(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  instruction: string,
  schema: 'task_result',
  options?: StructuredDelegationOptions
): Promise<TaskResultBlock>;
export function delegateStructured(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  instruction: string,
  schema: 'a2a_task_contract',
  options?: StructuredDelegationOptions
): Promise<A2ATaskContract>;
export function delegateStructured(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  instruction: string,
  schema: 'procedure_ranking',
  options?: StructuredDelegationOptions
): Promise<ProcedureRankingResult>;
export function delegateStructured<T>(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  instruction: string,
  schema: z.ZodType<T>,
  options?: StructuredDelegationOptions
): Promise<T>;
export async function delegateStructured<T>(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  instruction: string,
  schema: StructuredOutputSchemaRef<T>,
  options: StructuredDelegationOptions = {}
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const constrainedSampling = resolveConstrainedSampling(
    options.constrainedSampling,
    options.capabilityProfile ?? { supportsStrictTools: false, supportsGrammarTools: false }
  );
  const resolvedSchema = resolveStructuredOutputSchema(schema);
  const schemaJson = z.toJSONSchema(resolvedSchema) as Record<string, unknown>;
  if ('$schema' in schemaJson) delete schemaJson['$schema'];

  const buildPrompt = (attempt: number, priorError?: string): string =>
    [
      STRUCTURED_DELEGATION_PROMPT_HEADER,
      'Do not wrap the JSON in markdown fences.',
      'Do not add explanatory prose.',
      attempt > 0 ? `Retry attempt ${attempt} after schema mismatch: ${priorError}` : '',
      constrainedSampling.mode === 'fallback'
        ? 'Native constrained sampling is unavailable; use the existing schema validator as the fallback.'
        : constrainedSampling.mode === 'native'
          ? 'The selected adapter declares native constrained sampling support; keep output strictly within the schema.'
          : '',
      'Schema:',
      JSON.stringify(schemaJson, null, 2),
      '',
      'Task:',
      instruction,
    ]
      .filter(Boolean)
      .join('\n');

  let lastError = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await backend.delegateTask(buildPrompt(attempt, lastError), options.context, {
      ...(constrainedSampling.mode === 'native' && constrainedSampling.request
        ? { constrainedSampling: constrainedSampling.request }
        : {}),
    });
    try {
      const parsed = parseStructuredJson(raw, 'delegateStructured');
      const validated = resolvedSchema.safeParse(parsed);
      if (validated.success) return validated.data;
      lastError = validated.error.message;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    `[reasoning-backend] structured delegation failed after ${maxRetries + 1} attempts: ${lastError}`
  );
}

export async function delegateBestOf<T>(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  instruction: string,
  schema: z.ZodType<T>,
  options: BestOfDelegationOptions = {}
): Promise<{ winner: T; candidates: T[]; judge: { winner_index: number; rationale: string } }> {
  const candidateCount = Math.max(2, options.candidateCount ?? 3);
  const candidateRuns = await Promise.all(
    Array.from({ length: candidateCount }, async (_, index) =>
      delegateStructured(
        backend,
        [
          instruction,
          '',
          `Variant guidance: this is candidate ${index + 1}/${candidateCount}. Produce a distinct answer that still satisfies the schema.`,
        ].join('\n'),
        schema,
        {
          context: `${options.context ?? 'delegateBestOf'}:candidate=${index + 1}/${candidateCount}`,
          maxRetries: options.maxRetries,
        }
      )
    )
  );

  const judgeSchema = z.object({
    winner_index: z
      .number()
      .int()
      .min(0)
      .max(candidateRuns.length - 1),
    rationale: z.string().min(1),
  });
  const judge = await delegateStructured(
    backend,
    [
      'Select the single best candidate from the JSON array below.',
      options.judgeInstructions
        ? `Rubric: ${options.judgeInstructions}`
        : 'Rubric: prefer the most complete, useful, and schema-faithful candidate.',
      '',
      'Candidates:',
      JSON.stringify(candidateRuns, null, 2),
      '',
      'Return a JSON object with { "winner_index": number, "rationale": string }.',
    ].join('\n'),
    judgeSchema,
    {
      context: `${options.context ?? 'delegateBestOf'}:judge`,
      maxRetries: options.maxRetries,
    }
  );

  return {
    winner: candidateRuns[judge.winner_index],
    candidates: candidateRuns,
    judge,
  };
}

export interface UntrustedDataParams {
  untrustedData: string;
  sourceLabel?: string;
}

/**
 * Securely delegates a task that involves processing untrusted external data (e.g., emails, web pages, logs).
 * It strongly separates the system instruction from the untrusted data using the KD-04 injection framing
 * contract (`frameUntrustedInput`): HTML-escape + `<untrusted_data source="...">` tag + a fixed boilerplate
 * instructing the LLM to treat the contents strictly as data, never as instructions.
 */
export async function delegateTaskWithUntrustedData(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  instruction: string,
  params: UntrustedDataParams,
  options?: ReasoningCallOptions & {
    context?: string;
    /** QM-09: receives the named-phase latency breakdown of this delegation. */
    onGapPhases?: (samples: GapPhaseSample[]) => void;
  }
): Promise<string> {
  const gaps = createGapRecorder();
  // Strip the observer before forwarding: backends receive plain data options,
  // never a function-valued key a future structuredClone would choke on.
  const { onGapPhases, ...backendOptions } = options ?? {};
  try {
    const prompt = gaps.measureSync(
      'prompt_build',
      () => `${instruction}

${frameUntrustedInput({ data: params.untrustedData, source: params.sourceLabel || 'external data' })}`
    );
    return await gaps.measure('backend_dispatch', () =>
      backend.delegateTask(prompt, backendOptions.context, backendOptions)
    );
  } finally {
    if (onGapPhases) {
      try {
        onGapPhases(gaps.samples());
      } catch (error) {
        logger.warn(`[QM-09] gap-phase observer failed (ignored): ${error}`);
      }
    }
  }
}

const PEER_ADVICE_SCHEMA = z.object({
  advisor_label: z.string().min(1),
  advisor_provider: z.string().optional(),
  recommendation: z.string().min(1),
  risks: z.array(z.string()).default([]),
  follow_up_questions: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
});

export async function requestPeerAdvice(
  backend: ReasoningBackend,
  input: PeerAdviceInput,
  options: ReasoningCallOptions & StructuredDelegationOptions = {}
): Promise<PeerAdviceResult> {
  const selectedCandidate =
    backend instanceof FailoverReasoningBackend
      ? backend.selectConsultationCandidate({
          preferredProvider: input.preferred_provider,
          preferredLabel: input.preferred_label,
        })
      : null;
  const selectedBackend = selectedCandidate?.backend ?? backend;
  const prompt = [
    'You are acting as a peer reviewer and advisor for a sub-agent.',
    'Provide a direct second opinion, not a rewrite of the original task.',
    'Be concrete about risks and the next question to ask if the recommendation is uncertain.',
    `Tone: ${input.tone || 'careful'}`,
    `Question: ${input.question}`,
    input.context ? `Context:\n${input.context}` : '',
    'Return JSON only.',
  ]
    .filter(Boolean)
    .join('\n');
  const advice = await delegateStructured(selectedBackend, prompt, PEER_ADVICE_SCHEMA, {
    context: options.context || 'peer_advice',
    maxRetries: options.maxRetries ?? 1,
  });
  return {
    ...advice,
    advisor_label: advice.advisor_label || selectedCandidate?.label || selectedBackend.name,
    advisor_provider: advice.advisor_provider || selectedCandidate?.provider || undefined,
    peer_used: selectedBackend !== backend,
  };
}

const reasoningBackendSeam = createSeam<ReasoningBackend>({
  key: 'reasoning-backend',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

let registeredDisposer: (() => void) | null = null;

/** Register a real backend. Most deployments do this in a bootstrap module. */
export function registerReasoningBackend(
  backend: ReasoningBackend,
  metadata: SeamProviderMetadata = { provenance: 'builtin', source: backend.name }
): () => void {
  const rawDisposer = reasoningBackendSeam.register('active', backend, metadata);
  const disposer = () => {
    rawDisposer();
    if (registeredDisposer === disposer) registeredDisposer = null;
  };
  registeredDisposer = disposer;
  return disposer;
}

/** Get the active backend, falling back to the deterministic stub. */
export function getReasoningBackend(): ReasoningBackend {
  return reasoningBackendSeam.getOptional() ?? stubReasoningBackend;
}

/** Clear the registered backend. Used by tests. */
export function resetReasoningBackend(): void {
  registeredDisposer?.();
  registeredDisposer = null;
  resetStubServedOps();
}

const UNCONFIGURED_STUB_WARNING =
  'Reasoning backend is not configured. Run `pnpm reasoning:setup` before using Kyberion for real work.';

function stubText(message: string): string {
  return stubExplicitlyRequested() ? message : `${UNCONFIGURED_STUB_WARNING}\n${message}`;
}

/**
 * LC-07 (LOOP_CLOSURE_PLAN): stub-taint registry. Every stub op invocation is
 * recorded process-wide so completion gates (intent-reconciliation) can refuse
 * to mark work "done" when its judgments came from fabricated placeholders.
 * Explicit stub mode (KYBERION_REASONING_BACKEND=stub) opts out — that is the
 * deterministic-test configuration where stub output is the point.
 */
export interface StubServedRecord {
  op: string;
  at: number;
}

const stubServedOps: StubServedRecord[] = [];
const STUB_SERVED_CAP = 500;

export function stubExplicitlyRequested(): boolean {
  return getRegisteredEnvText('KYBERION_REASONING_BACKEND') === 'stub';
}

function recordStubServed(op: string, detail?: string): void {
  if (stubServedOps.length < STUB_SERVED_CAP) {
    stubServedOps.push({ op, at: Date.now() });
  }
  logger.warn(
    `[reasoning-backend:stub] ${op} — no real backend registered${detail ? `; ${detail}` : ''}`
  );
}

export function getStubServedOps(): readonly StubServedRecord[] {
  return stubServedOps;
}

/** Clear the stub-taint registry. Used by tests and by resetReasoningBackend. */
export function resetStubServedOps(): void {
  stubServedOps.length = 0;
}

/** Deterministic, offline backend that emits structured placeholders. */
export const stubReasoningBackend: ReasoningBackend = {
  name: 'stub',

  async divergePersonas(input) {
    recordStubServed('divergePersonas', `topic="${input.topic}"`);
    const min = Math.max(1, input.minPerPersona ?? 1);
    const out: HypothesisSketch[] = [];
    for (const persona of input.personas) {
      for (let i = 0; i < min; i++) {
        out.push({
          id: `H-${slugify(persona, { mode: 'whitespace', separator: '_', maxLength: 48 })}-${i + 1}`,
          proposed_by: persona,
          content: `[STUB] Hypothesis ${i + 1} from ${persona} on "${input.topic}"`,
          status: 'pending',
        });
      }
    }
    return out;
  },

  async crossCritique(input) {
    recordStubServed('crossCritique');
    const hypotheses = input.hypotheses.map((hypothesis, idx) => {
      const critics = input.personas.filter((p) => p !== hypothesis.proposed_by).slice(0, 1);
      const survived = idx % 2 === 0;
      return {
        ...hypothesis,
        survived,
        status: survived ? ('survived' as const) : ('rejected' as const),
        rejection_reason: survived ? undefined : '[STUB] not selected by critique pass',
        critiques: critics.map((p) => ({ by: p, content: `[STUB] critique by ${p}` })),
      };
    });
    return { hypotheses };
  },

  async synthesizePersona(input) {
    recordStubServed('synthesizePersona');
    const node = input.relationshipNode as {
      identity?: Record<string, unknown>;
      communication_style?: Record<string, unknown>;
      ng_topics?: string[];
      history?: unknown[];
    };
    return {
      fidelity: input.fidelity ?? 'high',
      identity: (node.identity ?? {}) as Record<string, unknown>,
      style_hints: node.communication_style ?? {},
      ng_topics: node.ng_topics ?? [],
      recent_history_summary: (node.history ?? []).slice(-3),
    };
  },

  async forkBranches(input) {
    recordStubServed('forkBranches');
    const surviving = input.hypotheses.filter((h) => h.status !== 'rejected');
    return surviving.map((h, i) => ({
      branch_id: String.fromCharCode(65 + i),
      hypothesis_ref: h.id,
      worktree_path: `counterfactual-branches/branch-${String.fromCharCode(65 + i)}/`,
    }));
  },

  async simulateBranches(input) {
    recordStubServed('simulateBranches');
    return {
      branches: input.branches.map((b) => ({
        branch_id: b.branch_id,
        hypothesis_ref: b.hypothesis_ref,
        first_failure_mode: null,
        first_success_mode: null,
        terminated_at_step: null,
      })),
    };
  },

  async extractRequirements(input) {
    recordStubServed('extractRequirements', 'emitting a single placeholder requirement');
    const head =
      input.sourceText
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter(Boolean)[0] ?? '';
    const goalPreview = head.slice(0, 140);
    return {
      functional_requirements: [
        {
          id: 'FR-STUB1',
          description: goalPreview || '[STUB] Replace with extracted functional requirement',
          priority: 'should',
          acceptance_criteria: ['[STUB] Add acceptance criterion'],
        },
      ],
      non_functional_requirements: [],
      constraints: [],
      assumptions: [],
      open_questions: [
        {
          question:
            '[STUB] No real reasoning backend is registered — register a provider backend and re-run.',
          status: 'open',
        },
      ],
    };
  },

  async extractDesignSpec(_input) {
    recordStubServed('extractDesignSpec');
    return {
      architecture_summary:
        '[STUB] Register a real backend to generate a real architecture summary.',
      components: [
        {
          id: 'COMP-STUB1',
          name: '[STUB] Core Component',
          responsibility: '[STUB] Replace with extracted responsibility',
        },
      ],
      data_flows: [],
      trade_offs: [],
      risks: [],
      open_decisions: [
        {
          decision: '[STUB] No real backend registered — cannot generate design',
          blocking: true,
        },
      ],
    };
  },

  async extractTestPlan(input) {
    recordStubServed('extractTestPlan');
    return {
      app_id: input.appId ?? 'stub-app',
      cases: [
        {
          case_id: 'TC-STUB1',
          title: '[STUB] Placeholder test case',
          objective: '[STUB] Register a real backend to generate test cases from requirements',
          steps: ['[STUB] Step 1'],
          expected: '[STUB] Expected outcome',
        },
      ],
    };
  },

  async decomposeIntoTasks(_input) {
    recordStubServed('decomposeIntoTasks');
    return {
      strategy_summary: '[STUB] No real backend registered. Register a provider backend.',
      tasks: [
        {
          task_id: 'T-STUB-1',
          title: '[STUB] Placeholder task',
          summary: '[STUB] Replace with real decomposition',
          priority: 'should',
          estimate: 'M',
        },
      ],
    };
  },

  async delegateTask(instruction, context) {
    recordStubServed('delegateTask', `instruction="${instruction}"`);
    return stubText(`[STUB] Delegated task execution (stub). Context: ${context ?? 'none'}`);
  },

  delegateTaskHandle(instruction, context, options) {
    return createDelegationHandle({
      instruction,
      ...(context ? { context } : {}),
      backendName: 'stub',
      ...(options?.continuable ? { continuable: true } : {}),
      execute: (signal) =>
        stubReasoningBackend.delegateTask(instruction, context, {
          ...options,
          ...(signal ? { signal } : {}),
        }),
    });
  },

  async prompt(prompt, options) {
    throwIfReasoningAborted(options?.signal);
    recordStubServed('prompt', `prompt="${prompt.slice(0, 80)}"`);
    return stubText(`[STUB] ${prompt}`);
  },
};
