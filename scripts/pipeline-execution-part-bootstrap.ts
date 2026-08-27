import {
  recordGovernanceAction,
  TraceContext,
  finalizeAndPersist,
  persistTrace,
  logger,
  safeExec,
  safeExistsSync,
  safeWriteFile,
  safeMkdir,
  retry,
  resolveVars,
  capabilityEntry,
  pathResolver,
  getReasoningBackend,
  getReasoningRuntimeInstructions,
  renderRuntimeInstructions,
  buildWorkingPrinciplesLines,
  executeReportContract,
  getReasoningPayloadScope,
  resolveFacets,
  renderFacets,
  resolveStepReasoningRoute,
  determineActuatorStepType,
  resolveActuatorOperation,
  safeExecResult,
  runJanitor,
  checkActuatorCapabilities,
  validateOpInput,
  getRegisteredEnv,
  resolveIdentityContext,
  type ReasoningCallOptions,
  defineLegacyPipelineActuator,
  type PipelineRunJournalHandle,
  type PipelineRunJournalState,
  type PipelineRunSuspendedPayload,
} from '@agent/core';

import { markRouterActive, markRouterInactive } from '@agent/core/blackhole-routing-guard';
import * as nodePath from 'node:path';
import { type PipelineAdfStep, type PipelineStepReasoning } from '@agent/core/pipeline-contract';
import { type PipelineFailure } from './pipeline-result-reporting.js';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPipelinePromptVisibilityContext } from './pipeline-reasoning-visibility.js';

export function registeredEnv(name: string): string | undefined {
  return getRegisteredEnv<string>(name) as string | undefined;
}

/** Resolve the effective step type from role/type. role takes precedence. */
export function resolveStepType(step: PipelineAdfStep): string {
  if (step.role) {
    if (step.role === 'source') return 'capture';
    if (step.role === 'transform') return 'transform';
    if (step.role === 'sink') return 'apply';
    if (step.role === 'gate') return 'control';
  }
  if (step.type) return step.type;
  // No declared role/type: the op registry is the truth for actuator ops —
  // a blind 'apply' default routed transform ops into the wrong dispatch
  // switch (UNKNOWN_OP inside the actuator; found by loop simulation).
  if (typeof step.op === 'string' && step.op.includes(':')) {
    const [domain, action] = step.op.split(':');
    try {
      return determineActuatorStepType(domain, action);
    } catch {
      /* unregistered op — keep the legacy default */
    }
  }
  return 'apply';
}

/** Resolve the export key from produces / params.export_as. produces takes precedence. */
export function resolveExportKey(step: PipelineAdfStep, defaultKey: string): string {
  if (step.produces) {
    return typeof step.produces === 'string' ? step.produces : step.produces.channel;
  }
  return String(step.params?.export_as ?? defaultKey);
}

export type RunStepResult = {
  op: string;
  status: 'success' | 'failed' | 'skipped' | 'recovered';
  error?: string;
};

export function runTsFallbackPipeline(fallbackPath: string): ReturnType<typeof safeExecResult> {
  const fallbackEntry = pathResolver.rootResolve('scripts/run_pipeline.ts');
  const tsxAvailable = safeExecResult('node', ['--import', 'tsx', '--eval', 'process.exitCode=0'], {
    cwd: pathResolver.rootDir(),
    env: {
      KYBERION_PIPELINE_FALLBACK_ACTIVE: '1',
    },
  });
  if (tsxAvailable.status !== 0) {
    const message =
      'tsx fallback is unavailable. Run `pnpm build` so dist/scripts/run_pipeline.js is available.';
    logger.error(`❌ [PIPELINE] ${message}`);
    throw new Error(message);
  }
  logger.warn(
    `⚠️ [PIPELINE] Running fallback pipeline from source because dist/scripts/run_pipeline.js was not used: ${fallbackPath}`
  );
  return safeExecResult('node', ['--import', 'tsx', fallbackEntry, '--input', fallbackPath], {
    cwd: pathResolver.rootDir(),
    env: {
      KYBERION_PIPELINE_FALLBACK_ACTIVE: '1',
    },
  });
}

export function recordFallbackOutcome(
  trace: TraceContext,
  fallbackPath: string,
  failure: PipelineFailure,
  outcome: { status: number; error?: unknown }
): boolean {
  const recovered = outcome.status === 0;
  const fallbackError =
    outcome.error instanceof Error ? outcome.error.message : String(outcome.error || '');
  trace.addEvent(recovered ? 'pipeline.fallback_succeeded' : 'pipeline.fallback_failed', {
    fallback_pipeline: fallbackPath,
    primary_error_category: failure.classification.category,
    primary_error_rule_id: failure.classification.ruleId,
    fallback_exit_status: outcome.status,
    ...(fallbackError ? { fallback_error: fallbackError } : {}),
  });
  return recovered;
}

export function tryPermissionFallback(
  pipeline: Record<string, unknown>,
  failure: PipelineFailure,
  trace: TraceContext
): boolean {
  const fallbackPath = String(pipeline.fallback_pipeline || '');
  if (
    !fallbackPath ||
    failure.classification.category !== 'permission_denied' ||
    registeredEnv('KYBERION_PIPELINE_FALLBACK_ACTIVE')
  ) {
    return false;
  }

  logger.warn(
    `⚠️ [PIPELINE] Primary first-win failed with permission denial. Running fallback pipeline: ${fallbackPath}`
  );
  trace.addEvent('pipeline.fallback_started', {
    fallback_pipeline: fallbackPath,
    primary_error_category: failure.classification.category,
    primary_error_rule_id: failure.classification.ruleId,
  });

  try {
    const fallbackResult = runTsFallbackPipeline(fallbackPath);
    const recovered = recordFallbackOutcome(trace, fallbackPath, failure, fallbackResult);
    if (recovered) {
      logger.success(`✅ [PIPELINE] Fallback succeeded: ${fallbackPath}`);
      return true;
    }
    logger.error(`❌ [PIPELINE] Fallback failed: ${fallbackPath}`);
    if (fallbackResult.stdout.trim()) logger.error(fallbackResult.stdout.trim());
    if (fallbackResult.stderr.trim()) logger.error(fallbackResult.stderr.trim());
  } catch (error: any) {
    recordFallbackOutcome(trace, fallbackPath, failure, {
      status: 1,
      error: error?.message ?? String(error),
    });
    logger.error(`❌ [PIPELINE] Fallback failed: ${fallbackPath}`);
  }
  return false;
}

export function finalizePipelineTrace(
  trace: TraceContext,
  recovered = false,
  opts?: { dir?: string }
) {
  if (!recovered) return finalizeAndPersist(trace, opts);
  const finalized = trace.finalize();
  // A recovered run retains the failed primary child span, but its final outcome is successful.
  finalized.rootSpan.status = 'ok';
  return { trace: finalized, path: persistTrace(finalized, opts) };
}

export interface NormalizedStepBudget {
  cost_cap_tokens?: number;
  max_prompt_chars?: number;
  max_response_chars?: number;
  max_combined_chars?: number;
  approval_required?: boolean;
  approval_ref?: string;
}

export interface ReasoningStepPolicy {
  effort?: 'low' | 'medium' | 'high';
  budget?: NormalizedStepBudget;
  reasoning?: PipelineStepReasoning;
}

export function normalizeStepBudget(raw: unknown): NormalizedStepBudget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const budget = raw as Record<string, unknown>;
  const normalized: NormalizedStepBudget = {};
  const coercePositiveInt = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const rounded = Math.floor(value);
    return rounded > 0 ? rounded : undefined;
  };
  const costCapTokens = coercePositiveInt(budget.cost_cap_tokens ?? budget.costCapTokens);
  const maxPromptChars = coercePositiveInt(budget.max_prompt_chars ?? budget.maxPromptChars);
  const maxResponseChars = coercePositiveInt(budget.max_response_chars ?? budget.maxResponseChars);
  const maxCombinedChars = coercePositiveInt(budget.max_combined_chars ?? budget.maxCombinedChars);
  if (costCapTokens !== undefined) normalized.cost_cap_tokens = costCapTokens;
  if (maxPromptChars !== undefined) normalized.max_prompt_chars = maxPromptChars;
  if (maxResponseChars !== undefined) normalized.max_response_chars = maxResponseChars;
  if (maxCombinedChars !== undefined) normalized.max_combined_chars = maxCombinedChars;
  if (budget.approval_required === true || budget.approvalRequired === true) {
    normalized.approval_required = true;
  }
  if (typeof budget.approval_ref === 'string' && budget.approval_ref.trim()) {
    normalized.approval_ref = budget.approval_ref.trim();
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeReasoningPolicy(step: PipelineAdfStep): ReasoningStepPolicy {
  return {
    effort:
      step.effort === 'low' || step.effort === 'medium' || step.effort === 'high'
        ? step.effort
        : undefined,
    budget: normalizeStepBudget(step.budget),
    reasoning: step.reasoning,
  };
}

export function summarizeReasoningPolicy(
  policy: ReasoningStepPolicy
): Record<string, string | number | boolean> {
  const summary: Record<string, string | number | boolean> = {};
  if (policy.effort) summary.step_effort = policy.effort;
  if (policy.budget?.cost_cap_tokens !== undefined)
    summary.budget_cost_cap_tokens = policy.budget.cost_cap_tokens;
  if (policy.budget?.max_prompt_chars !== undefined)
    summary.budget_max_prompt_chars = policy.budget.max_prompt_chars;
  if (policy.budget?.max_response_chars !== undefined)
    summary.budget_max_response_chars = policy.budget.max_response_chars;
  if (policy.budget?.max_combined_chars !== undefined)
    summary.budget_max_combined_chars = policy.budget.max_combined_chars;
  if (policy.budget?.approval_required) summary.budget_approval_required = true;
  return summary;
}

export function buildReasoningPolicyNote(policy: ReasoningStepPolicy): string {
  const parts: string[] = [];
  if (policy.effort) parts.push(`effort=${policy.effort}`);
  if (policy.budget?.cost_cap_tokens !== undefined)
    parts.push(`cost_cap_tokens=${policy.budget.cost_cap_tokens}`);
  if (policy.budget?.max_prompt_chars !== undefined)
    parts.push(`max_prompt_chars=${policy.budget.max_prompt_chars}`);
  if (policy.budget?.max_response_chars !== undefined)
    parts.push(`max_response_chars=${policy.budget.max_response_chars}`);
  if (policy.budget?.max_combined_chars !== undefined)
    parts.push(`max_combined_chars=${policy.budget.max_combined_chars}`);
  if (policy.budget?.approval_required) parts.push('approval_required=true');
  if (policy.reasoning?.profile) parts.push(`profile=${policy.reasoning.profile}`);
  if (policy.reasoning?.provider) parts.push(`provider=${policy.reasoning.provider}`);
  if (policy.reasoning?.model) parts.push(`model=${policy.reasoning.model}`);
  if (policy.reasoning?.permission_mode)
    parts.push(`permission=${policy.reasoning.permission_mode}`);
  return parts.length > 0 ? `\n\n[policy ${parts.join(' ')}]` : '';
}

export function resolvePipelineReasoningOptions(
  policy: ReasoningStepPolicy,
  ctx: Record<string, unknown>,
  stepId: string,
  trace?: TraceContext
): ReasoningCallOptions {
  const reasoning = policy.reasoning;
  const persona =
    (typeof ctx.persona === 'string' ? ctx.persona : undefined) ||
    (typeof ctx.assigned_persona === 'string' ? ctx.assigned_persona : undefined) ||
    registeredEnv('KYBERION_PERSONA') ||
    'default';
  const route = resolveStepReasoningRoute({
    stepId,
    persona,
    ...(reasoning ? { step: reasoning } : {}),
    ...(reasoning?.tags ? { tags: reasoning.tags } : {}),
    ...(typeof ctx.__pipeline_reasoning_profile === 'string'
      ? { pipelineProfile: ctx.__pipeline_reasoning_profile }
      : {}),
    env: process.env,
  });
  trace?.addEvent('reasoning.route_selected', {
    step_id: stepId,
    profile: route.profile || 'default',
    mode: route.mode || 'default',
    ...(route.model ? { model: route.model } : {}),
    permission_mode: route.permission_mode,
    source: route.source,
    provenance: route.provenance.join(','),
  });
  return {
    ...(route.profile ? { route_profile: route.profile } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(reasoning?.model_tier ? { model_tier: reasoning.model_tier } : {}),
    ...(route.capability_profile ? { profile: route.capability_profile } : {}),
    permission_mode: route.permission_mode,
    ...(persona !== 'default' ? { role: persona } : {}),
  } satisfies ReasoningCallOptions;
}

export function resolvePipelineFacetNote(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): string {
  const raw = params._facets ?? params.facets;
  if (!raw || typeof raw !== 'object') return '';
  const request = raw as {
    persona?: string;
    policies?: string[];
    instructions?: string[];
    output_contract?: string;
  };
  const tierValue =
    ctx.__knowledge_tier ??
    ctx.knowledge_tier ??
    registeredEnv('KYBERION_KNOWLEDGE_TIER') ??
    'public';
  const tier = tierValue === 'personal' || tierValue === 'confidential' ? tierValue : 'public';
  const requestedTenantSlug =
    typeof ctx.tenant_slug === 'string'
      ? ctx.tenant_slug
      : typeof ctx.tenant_id === 'string'
        ? ctx.tenant_id
        : undefined;
  const payloadScope = getReasoningPayloadScope();
  const identityTenant = resolveIdentityContext().tenantSlug;
  const authorizedTenant = payloadScope?.tenant_slug || identityTenant;
  if (requestedTenantSlug && authorizedTenant && requestedTenantSlug !== authorizedTenant) {
    throw new Error(
      `[FACET_SCOPE_DENIED] requested tenant '${requestedTenantSlug}' does not match the authorized tenant scope`
    );
  }
  if (requestedTenantSlug && !authorizedTenant) {
    throw new Error(
      '[FACET_SCOPE_DENIED] tenant facet resolution requires an authorized tenant scope'
    );
  }
  return renderFacets(
    resolveFacets(request, { tier, ...(authorizedTenant ? { tenantSlug: authorizedTenant } : {}) })
  );
}

export async function runPipelineReportPhase(
  step: PipelineAdfStep,
  ctx: Record<string, unknown>,
  trace?: TraceContext
): Promise<Record<string, unknown>> {
  const reports = step.report
    ? (Array.isArray(step.report) ? step.report : [step.report])
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [];
  if (reports.length === 0) return ctx;
  const backend = getReasoningBackend();
  let workingCtx = ctx;
  for (const contract of reports) {
    let reportSucceeded = false;
    trace?.startSpan(`phase.report.${step.id || step.op}`, {
      phase: 'report',
      schema_ref: contract.schema_ref,
      ...(contract.use_judge ? { use_judge: true } : {}),
      order: contract.order ?? 0,
    });
    try {
      const report = await executeReportContract(
        backend,
        contract,
        [
          `Summarize the completed perform phase for step ${step.id || step.op}.`,
          'The report phase is read-only. Do not request or perform external side effects.',
          `Perform context:\n${JSON.stringify(workingCtx)}`,
        ].join('\n\n')
      );
      const exportKey = contract.export_as || 'last_report';
      trace?.addEvent('report.completed', {
        step_id: step.id || step.op,
        schema_ref: contract.schema_ref,
        export_as: exportKey,
        order: contract.order ?? 0,
        ...(contract.use_judge ? { use_judge: true } : {}),
      });
      workingCtx = { ...workingCtx, [exportKey]: report };
      reportSucceeded = true;
    } catch (error) {
      trace?.addEvent('report.failed', {
        step_id: step.id || step.op,
        schema_ref: contract.schema_ref,
        error: error instanceof Error ? error.message : String(error),
      });
      trace?.endSpan('error', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (reportSucceeded) trace?.endSpan('ok');
    }
  }
  return workingCtx;
}

export function isReasoningBudgetExceeded(
  policy: ReasoningStepPolicy,
  prompt: string,
  responseText: string
): string | null {
  const promptChars = prompt.length;
  const responseChars = responseText.length;
  const combinedChars = promptChars + responseChars;
  if (
    policy.budget?.max_prompt_chars !== undefined &&
    promptChars > policy.budget.max_prompt_chars
  ) {
    return `prompt budget exceeded (${promptChars}/${policy.budget.max_prompt_chars} chars)`;
  }
  if (
    policy.budget?.max_response_chars !== undefined &&
    responseChars > policy.budget.max_response_chars
  ) {
    return `response budget exceeded (${responseChars}/${policy.budget.max_response_chars} chars)`;
  }
  if (
    policy.budget?.max_combined_chars !== undefined &&
    combinedChars > policy.budget.max_combined_chars
  ) {
    return `combined budget exceeded (${combinedChars}/${policy.budget.max_combined_chars} chars)`;
  }
  return null;
}

export interface FlowValidationError {
  stepId: string;
  missing: string[];
}

/**
 * Pre-execution validation: checks that every channel listed in `consumes`
 * was produced by a preceding step (or is present in the initial context).
 * Returns an array of errors (empty = valid).
 */
export function validateFlow(
  steps: PipelineAdfStep[],
  initialCtx: Record<string, unknown> = {}
): FlowValidationError[] {
  const available = new Set<string>(Object.keys(initialCtx));
  const errors: FlowValidationError[] = [];

  for (const step of steps) {
    const id = step.id ?? step.op;
    const consumed = step.consumes
      ? Array.isArray(step.consumes)
        ? step.consumes
        : [step.consumes]
      : [];
    const missing = consumed.filter((ch) => !available.has(ch));
    if (missing.length > 0) errors.push({ stepId: id, missing });

    // Register what this step produces for downstream steps
    if (step.produces) {
      const ch = typeof step.produces === 'string' ? step.produces : step.produces.channel;
      available.add(ch);
    } else if (step.params?.export_as && typeof step.params.export_as === 'string') {
      available.add(step.params.export_as);
    }
    // Gate steps don't block channel availability — nested steps are handled separately
  }
  return errors;
}

export function formatFlowValidationErrors(errors: FlowValidationError[]): string {
  return errors
    .map(
      (error) => `Step "${error.stepId}" consumes unknown channel(s): ${error.missing.join(', ')}`
    )
    .join('; ');
}

export type DispatchFunc = (
  op: string,
  params: any,
  ctx: Record<string, unknown>,
  type?: string,
  trace?: TraceContext,
  policy?: ReasoningStepPolicy
) => Promise<{ handled: boolean; ctx: Record<string, unknown> }>;

export const dispatchCache: Record<string, DispatchFunc> = {};
export const moduleCache: Record<string, any> = {};

export interface RunStepsOptions {
  trace?: TraceContext;
  _includeStack?: ReadonlySet<string>;
  pipelinePath?: string;
  quiet?: boolean;
  /** Trusted execution-boundary signal for human-gated operations. */
  hasHuman?: boolean;
  runJournal?: PipelineRunJournalHandle;
  resumeState?: PipelineRunJournalState;
  runId?: string;
  /** Prevent an invalid flow from re-entering the repair gate indefinitely. */
  _adfRepairAttempted?: boolean;
  /** Execute a nested validated pipeline without spawning run_pipeline. */
  runPipelineFile?: (
    inputPath: string,
    options?: {
      context?: Record<string, unknown>;
      quiet?: boolean;
      hasHuman?: boolean;
    }
  ) => Promise<{
    status?: string;
    results: unknown[];
    context: Record<string, unknown>;
  }>;
}

export function resolvePipelineHumanPresence(): boolean | undefined {
  if (registeredEnv('KYBERION_NON_INTERACTIVE') === '1') return false;
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  return undefined;
}

export class PipelineSuspendedError extends Error {
  readonly adfControlFlow = 'suspend' as const;
  readonly suspension: PipelineRunSuspendedPayload;

  constructor(suspension: PipelineRunSuspendedPayload) {
    super(`[PIPELINE_SUSPENDED] awaiting approval ${suspension.approval_request_id}`);
    this.name = 'PipelineSuspendedError';
    this.suspension = suspension;
  }
}

export function resolveParamsRecursive(params: any, ctx: any): any {
  if (Array.isArray(params)) {
    return params.map((item) => resolveParamsRecursive(item, ctx));
  }
  if (params && typeof params === 'object') {
    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, resolveParamsRecursive(value, ctx)])
    );
  }
  return resolveVars(params, ctx);
}

// Marks a genuine step failure inside an actuator's internal multi-step
// engine (handleAction returned status:'failed' rather than throwing).
export class ActuatorStepFailedError extends Error {}

export async function loadActuatorDispatch(
  domain: string,
  resolvedOperation?: ReturnType<typeof resolveActuatorOperation>
): Promise<DispatchFunc> {
  if (resolvedOperation?.handler) {
    const handler = resolvedOperation.handler;
    return (op, params, ctx, type, trace, policy) =>
      handler(op, params, ctx, type as any, trace, policy);
  }
  if (dispatchCache[domain]) return dispatchCache[domain];

  if (domain === 'reasoning') {
    dispatchCache[domain] = async (op, params, ctx, type, _trace?, policy?) => {
      const { getReasoningBackend } = await import('@agent/core');
      const backend = getReasoningBackend();
      if (op === 'analyze' || op === 'transform' || op === 'synthesize') {
        const resolvedInstruction =
          typeof params.instruction === 'string'
            ? resolveVars(params.instruction, ctx)
            : params.instruction;
        const resolvedContext = Array.isArray(params.context)
          ? params.context.map((item) => (typeof item === 'string' ? resolveVars(item, ctx) : item))
          : typeof params.context === 'string'
            ? resolveVars(params.context, ctx)
            : params.context || ctx;
        const reasoningPolicy =
          (params._reasoning_policy as ReasoningStepPolicy | undefined) ?? policy;
        const routeOptions = resolvePipelineReasoningOptions(
          reasoningPolicy || {},
          ctx,
          String(params.step_id || params.op || 'reasoning'),
          _trace
        );
        const facetNote = resolvePipelineFacetNote(params, ctx);
        const promptVisibility = buildPipelinePromptVisibilityContext(ctx);
        const reasoningCallOptions = {
          effort: reasoningPolicy?.effort,
          budget: reasoningPolicy?.budget,
          ...routeOptions,
          ...(promptVisibility ? { prompt_visibility: promptVisibility } : {}),
        };
        const runtimeNote = renderRuntimeInstructions(
          getReasoningRuntimeInstructions(backend, reasoningCallOptions)
        );
        const workingPrinciples = buildWorkingPrinciplesLines(
          typeof (reasoningCallOptions as { role?: unknown }).role === 'string'
            ? (reasoningCallOptions as unknown as { role: string }).role
            : undefined
        ).join('\n');
        const prompt = `Instruction: ${resolvedInstruction || 'Analyze the context.'}\nContext: ${JSON.stringify(resolvedContext)}${facetNote ? `\n\n${facetNote}` : ''}\n\n${workingPrinciples}${runtimeNote ? `\n\n${runtimeNote}` : ''}${buildReasoningPolicyNote(reasoningPolicy || {})}`;
        const preCallBudgetError = isReasoningBudgetExceeded(reasoningPolicy || {}, prompt, '');
        if (preCallBudgetError) {
          throw new Error(
            `Reasoning budget exceeded${reasoningPolicy?.budget?.approval_required ? '; approval required' : ''}: ${preCallBudgetError}`
          );
        }
        const rawResponse = shouldUseSubagentForReasoningStep(params)
          ? await backend.delegateTask(
              [
                String(resolvedInstruction || 'Analyze the context.'),
                workingPrinciples,
                runtimeNote,
              ]
                .filter(Boolean)
                .join('\n\n'),
              JSON.stringify(resolvedContext),
              reasoningCallOptions as any
            )
          : await retry(() => backend.prompt(prompt, reasoningCallOptions as any), {
              maxRetries: 2,
              initialDelayMs: 3000,
              maxDelayMs: 15000,
              factor: 2,
              shouldRetry: (err: Error) =>
                err.message.includes('timed out') ||
                err.message.includes('INVALID_STREAM') ||
                err.message.includes('empty response') ||
                err.message.includes('missing "response"'),
              onRetry: (err: Error, attempt: number) =>
                logger.warn(
                  `  [REASONING] Retry ${attempt}/2 for reasoning:analyze — ${err.message.slice(0, 120)}`
                ),
            });
        const postCallBudgetError = isReasoningBudgetExceeded(
          reasoningPolicy || {},
          prompt,
          String(rawResponse || '')
        );
        if (postCallBudgetError) {
          throw new Error(
            `Reasoning budget exceeded${reasoningPolicy?.budget?.approval_required ? '; approval required' : ''}: ${postCallBudgetError}`
          );
        }
        return {
          handled: true,
          ctx: { ...ctx, [params.export_as || 'last_reasoning']: rawResponse },
        };
      }
      return { handled: false, ctx };
    };
    return dispatchCache[domain];
  }

  const { resolveProviderCapabilityId, invokeProviderCapability } =
    await import('@agent/core/provider-bridge');

  dispatchCache[domain] = async (op, params, ctx, type, trace?) => {
    // SA-05 Task 1: actuator dispatch feeds kill-switch anomaly tracking.
    recordGovernanceAction(
      registeredEnv('KYBERION_PERSONA') || 'unknown',
      'actuator_dispatch',
      `${domain}:${op}`,
      false
    );
    const resolvedId = resolveProviderCapabilityId(domain, op);
    if (resolvedId) {
      const result = await invokeProviderCapability({
        capabilityId: resolvedId,
        args: params.args,
        payload: params.payload || params.instruction || params.prompt,
        context: ctx,
      });
      let parsed = result;
      try {
        parsed = JSON.parse(result);
      } catch (err) {
        logger.warn(`[run_pipeline] suppressed error in reasoningPolicy: ${err}`);
      }
      return {
        handled: true,
        ctx: { ...ctx, [params.export_as || 'last_provider_result']: parsed },
      };
    }

    let result = { handled: false, ctx };

    try {
      if (!moduleCache[domain]) {
        let entry = resolvedOperation
          ? pathResolver.rootResolve(resolvedOperation.modulePath)
          : capabilityEntry(`${domain}-actuator`);
        if (!safeExistsSync(entry)) {
          const directEntry = capabilityEntry(domain);
          if (safeExistsSync(directEntry)) {
            entry = directEntry;
          } else {
            logger.info(`  [SYS_PIPELINE] Debug: domain=${domain}, entry=${entry}`);
          }
        }
        moduleCache[domain] = await import(pathToFileURL(entry).href);
      }
      const mod = moduleCache[domain];

      const actuator =
        mod.actuator && typeof mod.actuator.dispatch === 'function'
          ? mod.actuator
          : typeof mod.handleAction === 'function'
            ? defineLegacyPipelineActuator({ id: domain, handleAction: mod.handleAction })
            : undefined;
      if (!actuator) throw new Error(`Actuator ${domain} does not expose the SDK ABI`);

      // Prefer a declared operation. Older actuators expose the contained
      // compatibility adapter's `execute` operation instead.
      const operation = Object.prototype.hasOwnProperty.call(actuator.ops, op) ? op : 'execute';
      let legacyType = type;
      if (!legacyType) {
        try {
          legacyType = determineActuatorStepType(domain, op);
        } catch {
          legacyType = 'apply';
        }
      }
      const input =
        operation === op
          ? params
          : {
              op,
              type: legacyType,
              params,
              options: ctx.__pipeline_options,
              ...(trace ? { pipelineTrace: trace } : {}),
            };
      const sdkResult = await actuator.dispatch(operation, input, ctx);
      if (!sdkResult.ok) {
        throw new ActuatorStepFailedError(
          sdkResult.error || `Actuator operation failed: ${domain}:${op}`
        );
      }
      const output = sdkResult.output;
      result = {
        handled: true,
        ctx:
          output && typeof output === 'object' && !Array.isArray(output)
            ? { ...ctx, ...(output as Record<string, unknown>) }
            : { ...ctx, [params.export_as || 'last_actuator_result']: output },
      };
    } catch (err) {
      throw err; // Ensure error propagates out of dispatch
    }
    return result;
  };
  return dispatchCache[domain];
}

export function normalizePipelineOp(op: string): string {
  if (op.includes(':')) {
    const [domain, action] = op.split(':');
    if (domain === 'mission' && action === 'list') return 'system:list_missions';
    if (domain === 'project' && action === 'list') return 'system:list_projects';
    if (domain === 'knowledge' && action === 'list') return 'system:list_knowledge';
    if (domain === 'capability' && action === 'list') return 'system:list_capabilities';
    if (domain === 'agent' && (action === 'list-manifests' || action === 'list_manifests'))
      return 'agent:list_manifests';
    if (domain === 'agent' && (action === 'list-runtimes' || action === 'list_runtimes'))
      return 'agent:list_runtimes';

    if (domain === 'mission') return `system:${action}`;
    return op;
  }
  if (op === 'if') return 'core:if';
  if (op === 'while' || op === 'loop_until') return 'core:while';
  if (op === 'retry_until_quality') return 'core:retry_until_quality';
  if (op === 'parallel_foreach') return 'core:parallel_foreach';
  if (op === 'team_lead') return 'core:team_lead';
  if (op === 'parallel_calls') return 'core:parallel_calls';
  if (op === 'accumulate') return 'core:accumulate';
  if (op === 'judge_route') return 'core:judge_route';
  if (op === 'await_decision') return 'core:await_decision';
  return `system:${op}`;
}

export function validatePipelineOpInput(
  domain: string,
  action: string,
  params: Record<string, unknown>
) {
  if (domain === 'core' || domain === 'reasoning') return;
  const validation = validateOpInput(domain as any, action, params);
  if (!validation.valid) {
    const errors = 'errors' in validation ? validation.errors : ['invalid input'];
    throw new Error(`[INVALID_OP_INPUT] ${domain}:${action}: ${errors.join('; ')}`);
  }
}

export function resolveLogMessage(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): string {
  const template = params.message ?? params.template ?? params.text ?? '';
  return String(resolveVars(template, ctx));
}

export function resolveActuatorManifestPath(
  domain: string
): { actuatorId: string; manifestPath: string } | null {
  const candidates = [`${domain}-actuator`, domain];
  for (const actuatorId of candidates) {
    const manifestPath = pathResolver.rootResolve(
      path.join('libs/actuators', actuatorId, 'manifest.json')
    );
    if (safeExistsSync(manifestPath)) return { actuatorId, manifestPath };
  }
  return null;
}

export async function assertPipelineStepCapabilityAvailable(
  domain: string,
  action: string
): Promise<void> {
  const manifest = resolveActuatorManifestPath(domain);
  if (!manifest) return;
  const status = await checkActuatorCapabilities(manifest.actuatorId, manifest.manifestPath);
  const capability = status.capabilities.find((entry) => entry.op === action);
  if (!capability || capability.available) return;
  const prereqText = capability.prerequisites?.length
    ? ` Prerequisites: ${capability.prerequisites.join(' | ')}`
    : '';
  throw new Error(
    `capability ${domain}:${action} unavailable: ${capability.reason || 'runtime prerequisite missing'}.${prereqText}`
  );
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function matchesArtifactPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const basename = path.posix.basename(normalizedPath);
  const matcher = globToRegExp(pattern.replace(/\\/g, '/'));
  return matcher.test(normalizedPath) || matcher.test(basename);
}

export function resolveFragmentPath(ref: string): string {
  if (path.isAbsolute(ref)) {
    throw new Error(`core:include: absolute paths are not allowed: ${ref}`);
  }
  const normalized = ref.startsWith('./') ? ref.slice(2) : ref;
  const pipelinesDir = path.join(pathResolver.rootDir(), 'pipelines');
  const relativeRef = normalized.startsWith('pipelines/')
    ? normalized.slice('pipelines/'.length)
    : normalized;
  const resolved = path.resolve(pipelinesDir, relativeRef);
  const rel = path.relative(pipelinesDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`core:include: path must be within pipelines/: ${ref}`);
  }
  return resolved;
}

export function shouldUseSubagentForReasoningStep(params: Record<string, unknown>): boolean {
  if (params.use_subagent === true) return true;
  const mode = String(params.execution_mode || params.mode || '');
  return mode === 'subagent' || mode === 'delegate';
}

export function coercePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runParallelBatches<T>(
  items: T[],
  concurrency: number,
  runner: (item: T, index: number) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      await runner(items[current], current);
    }
  });
  await Promise.all(workers);
}

export { formatPipelineFailure } from './pipeline-result-reporting.js';

// ── AR-01 Phase A: leaf inline-op handlers ─────────────────────────────────
// Extracted verbatim from the runSteps dispatch chain (design note in
// AR-01 plan doc). Each takes the step params + context and returns the
// updated context; control-flow ops (if/foreach/include/accumulate) stay
// inline until Phase C delegates the loop to the canonical engine.

export async function runInlineSystemExec(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  rootDir: string
): Promise<Record<string, unknown>> {
  const resolvedParams = resolveParamsRecursive(params, ctx) as Record<string, unknown>;
  const command = String(resolvedParams.command ?? resolvedParams.cmd ?? '');
  if (!command) {
    throw new Error('system:exec requires "command" param');
  }
  const args = Array.isArray(resolvedParams.args)
    ? resolvedParams.args.map((value) => String(value))
    : [];
  const env = Object.fromEntries(
    Object.entries((resolvedParams.env || {}) as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === 'string' ? String(value) : String(value),
    ])
  ) as Record<string, string>;
  const cwdValue =
    typeof resolvedParams.cwd === 'string' && resolvedParams.cwd.trim().length > 0
      ? String(resolvedParams.cwd)
      : rootDir;
  const timeoutMs =
    typeof resolvedParams.timeout_ms === 'number' ? resolvedParams.timeout_ms : undefined;
  const execResult = safeExecResult(command, args, {
    cwd: nodePath.isAbsolute(cwdValue) ? cwdValue : nodePath.resolve(rootDir, cwdValue),
    env,
    ...(timeoutMs ? { timeoutMs } : {}),
    input:
      typeof resolvedParams.input === 'string'
        ? String(resolveVars(resolvedParams.input, ctx))
        : undefined,
  });
  const exportValue = {
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    status: execResult.status,
  };
  if (resolvedParams.export_as && typeof resolvedParams.export_as === 'string') {
    ctx = { ...ctx, [resolvedParams.export_as]: exportValue };
  }
  const allowError = resolvedParams.allow_error === true || resolvedParams.allowError === true;
  if (!allowError && execResult.status !== 0) {
    throw new Error(
      execResult.stderr.trim() ||
        execResult.stdout.trim() ||
        `system:exec exited with status ${execResult.status}`
    );
  }
  return ctx;
}

export async function runInlineSystemWriteFile(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  rootDir: string
): Promise<Record<string, unknown>> {
  const enrichedCtx = { ...ctx, $now: new Date().toISOString() };
  const resolvedParams = resolveParamsRecursive(params, enrichedCtx);
  const writePath = nodePath.resolve(rootDir, String(resolvedParams.path ?? ''));
  const rawContent = resolvedParams.content;
  const contentStr =
    typeof rawContent === 'string'
      ? rawContent
      : rawContent !== undefined
        ? JSON.stringify(rawContent, null, 2)
        : '';
  const dir = nodePath.dirname(writePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(writePath, contentStr);
  if (params.export_as && typeof params.export_as === 'string') {
    ctx = { ...ctx, [params.export_as]: contentStr };
  }
  return ctx;
}

export async function runInlineSystemShell(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  rootDir: string,
  shellBin: string
): Promise<Record<string, unknown>> {
  // Accept "command" as well as "cmd" (system:exec already does this) — 3
  // pipelines authored with "command" silently ran an empty shell command
  // that trivially "succeeded" while doing nothing, because this only ever
  // read "cmd". Fixed in the pipeline JSON too; kept forgiving here so a
  // future author can't fall into the same silent no-op.
  const cmd = String(resolveVars((params.cmd ?? params.command) || '', ctx));
  const env = Object.fromEntries(
    Object.entries((params.env || {}) as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === 'string' ? String(resolveVars(value, ctx)) : String(value),
    ])
  ) as Record<string, string>;
  const timeoutMs = typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined;
  const output = safeExec(shellBin, ['-c', cmd], {
    cwd: rootDir,
    env,
    ...(timeoutMs ? { timeoutMs } : {}),
  }).trim();
  let parsedOutput: unknown = output;
  if (output) {
    try {
      parsedOutput = JSON.parse(output);
    } catch {
      parsedOutput = output;
    }
  }
  if (params.export_as && typeof params.export_as === 'string') {
    ctx = { ...ctx, [params.export_as]: parsedOutput };
  }
  // Track BlackHole mic routing state for SIGINT cleanup.
  if (cmd.includes('blackhole_audio_router.py')) {
    if (cmd.includes('setup_routing')) {
      const pythonBin = cmd.split(/\s+/)[0];
      const defaultMicDevice = String(ctx.default_mic_device || 'MacBook Pro Microphone');
      markRouterActive(pythonBin, defaultMicDevice, rootDir);
    } else if (cmd.includes('reset_routing')) {
      markRouterInactive();
    }
  }
  return ctx;
}

export async function runInlineCoreWait(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const ms = Number(resolveVars(params.duration_ms || params.ms || 1000, ctx));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return ctx;
}

export function runInlineCoreJanitor(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const dryRunParam = resolveVars(params.dry_run ?? params.dryRun ?? true, ctx);
  const dryRun = dryRunParam === true || dryRunParam === 'true';
  const report = runJanitor({ dryRun });
  const exportKey = resolveExportKey(step, 'janitor_report');
  ctx = { ...ctx, [exportKey]: report };
  return ctx;
}

export async function runInlineCoreTransform(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { Buffer } = await import('node:buffer');
  const vm = await import('node:vm');
  const util = await import('node:util');
  const input = resolveVars(params.input || ctx, ctx);
  const script = String(params.script || 'input');
  // Wrap in IIFE so pipeline scripts can use `return` statements naturally
  const wrappedScript = `(function() { ${script} })()`;
  const sandbox = {
    Buffer,
    input,
    ctx: { ...ctx },
    console: {
      log: (...args: any[]) =>
        logger.info(
          `[TRANSFORM-LOG] ${args.map((a) => (typeof a === 'object' ? util.inspect(a) : a)).join(' ')}`
        ),
    },
  };
  vm.createContext(sandbox);
  const result = await new vm.Script(wrappedScript).runInContext(sandbox);
  const transformKey = resolveExportKey(step, 'last_transform');
  ctx = { ...ctx, [transformKey]: result };
  return ctx;
}

// ── AR-01 Phase C: delegate the control loop to the canonical engine ──────
// Everything below replaces the private `runSteps` loop with a set of
// engine handlers/hooks passed to `executeAdfSteps`. Design memo in the
// AR-01 plan doc. Three load-bearing decisions:
//
// 1. Routing is NOT based on step.type/role (resolveStepType almost never
//    returns 'control' — it's an actuator-dispatch hint, not a control-flow
//    classifier). Routing to the engine's control handler is based purely on
//    the normalized op matching one of the 6 known control actions.
// 2. on_error is handled natively by the engine (same handleStepError it
//    always used) instead of a duplicate implementation here — a step with
//    on_error skips autonomous-repair entirely and goes straight to the
//    engine's recovery path, so repair can never re-run a fallback that
//    on_error already attempted. Steps without on_error still get
//    repair+retry via runWithRepair, handler-internal (invisible to the
//    engine), matching Phase B's design.
// 3. Nested control-op bodies use the engine's own `runNestedSteps` (shared
//    hooks + shared step budget), so beforeStep/afterStep fire for nested
//    steps automatically — the final `results` array is built entirely from
//    those hook firings, which is what gives flattening (nested entries,
//    then the parent's own entry) for free with no manual result-splicing.
//
// Intentional semantic changes vs. the pre-Phase-C loop (documented, not
// covered by an existing test):
//  - All 6 control ops now propagate a failed nested/item run by throwing,
//    so the control step's own entry accurately reports 'failed' instead of
//    silently showing 'success' while a failed entry sits buried inside the
//    flattened results (this was already the actual behavior for
//    accumulate/parallel_foreach; foreach/if/while are now consistent).
//  - core:include no longer bypasses on_error/repair via a special
//    early-return; a fragment failure is a normal thrown error like any
//    other control op.

export const CONTROL_ACTIONS = new Set([
  'if',
  'switch',
  'while',
  'loop_until',
  'retry_until_quality',
  'foreach',
  'parallel_foreach',
  'team_lead',
  'parallel_calls',
  'accumulate',
  'judge_route',
  'await_decision',
  'include',
]);

/** Engine routing only: does NOT replace resolveStepType's actuator-dispatch hint. */
