import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import {
  validateAndRepairAdf,
  recordGovernanceAction,
  TraceContext,
  finalizeAndPersist,
  persistTrace,
  classifyError,
  formatClassification,
  logger,
  safeExec,
  safeReadFile,
  safeExistsSync,
  safeWriteFile,
  safeMkdir,
  retry,
  resolveVars,
  evaluateCondition,
  capabilityEntry,
  findMissionPath,
  missionEvidenceDir,
  pathResolver,
  installReasoningBackends,
  getReasoningBackend,
  getReasoningRuntimeInstructions,
  renderRuntimeInstructions,
  buildWorkingPrinciplesLines,
  executeReportContract,
  getReasoningPayloadScope,
  delegateStructured,
  createApprovalRequest,
  loadApprovalRequest,
  isApprovalRequestExpired,
  selectJudgeRoute,
  resolveMaxRouteHops,
  detectRouteCycle,
  resolveFacets,
  renderFacets,
  resolveStepReasoningRoute,
  runFeedbackLoop,
  determineActuatorStepType,
  resolveActuatorOperation,
  resolveActuatorOperationTimeout,
  getSemanticDecideDegradations,
  appendSemanticDegradationRun,
  recordAdhocPipelineRun,
  PROMOTION_CANDIDATE_MIN_RUNS,
  safeExecResult,
  buildNextActionFromError,
  formatNextAction,
  runJanitor,
  checkActuatorCapabilities,
  compactStepOutputContext,
  killSwitch,
  validateOpInput,
  getRegisteredEnv,
  resolveIdentityContext,
  executeAdfSteps,
  runAdfLifecycle,
  skipAdfStep,
  type AdfStep,
  type AdfStepHandlers,
  type AdfStepHooks,
  type AdfRunResult,
  type AdfSkippedStep,
  type ReasoningCallOptions,
  type ReasoningPromptVisibilityContext,
  executeProgrammaticToolCall,
  getDefaultWorkerEventStream,
  getDefaultLifecycleHookEngine,
  fireLifecycleHooks,
  withActuatorForwardingPort,
  type ActuatorForwardRequest,
  type ActuatorForwardingPort,
  withReasoningPayloadScope,
  runToolCallBatch,
  resolveOpAccessClaims,
  type ResourceClaim,
  type OpInputDomain,
  createPipelineRunJournal,
  openPipelineRunJournal,
  loadPipelineRunJournal,
  newPipelineRunId,
  hashPipelineOutput,
  type PipelineRunJournalHandle,
  type PipelineRunJournalState,
  type PipelineRunSuspendedPayload,
  deriveExecutionGraph,
  createGraphRunArtifact,
  recordGraphRunNode,
  persistGraphRunArtifact,
  type GraphRunArtifact,
  assessPipelineDryRun,
} from '@agent/core';

function registeredEnv(name: string): string | undefined {
  return getRegisteredEnv<string>(name) as string | undefined;
}
import { runOpPreflight } from '@agent/core/op-preflight';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { z } from 'zod';
import { tryRepairJson } from '@agent/core/json-repair';
import { installPythonVoiceBridgeIfAvailable } from '@agent/core/python-voice-bridge';
import {
  markRouterActive,
  markRouterInactive,
  resetRouterSync,
} from '@agent/core/blackhole-routing-guard';
import * as nodePath from 'node:path';
import {
  derivePipelineStatus,
  type PipelineAdfStep,
  type PipelineStepReasoning,
  ROLE_FROM_TYPE,
} from '@agent/core/pipeline-contract';

/** Resolve the effective step type from role/type. role takes precedence. */
function resolveStepType(step: PipelineAdfStep): string {
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
function resolveExportKey(step: PipelineAdfStep, defaultKey: string): string {
  if (step.produces) {
    return typeof step.produces === 'string' ? step.produces : step.produces.channel;
  }
  return String(step.params?.export_as ?? defaultKey);
}

type RunStepResult = {
  op: string;
  status: 'success' | 'failed' | 'skipped' | 'recovered';
  error?: string;
};

function runTsFallbackPipeline(fallbackPath: string): ReturnType<typeof safeExecResult> {
  const fallbackEntry = pathResolver.rootResolve('scripts/run_pipeline.ts');
  const tsxAvailable = safeExecResult('node', ['--import', 'tsx', '--eval', 'process.exit(0)'], {
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

type PipelineFailure = ReturnType<typeof formatPipelineFailure>;

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

function tryPermissionFallback(
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

function resolvePipelineReasoningOptions(
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

function resolvePipelineFacetNote(
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

async function runPipelineReportPhase(
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

function formatFlowValidationErrors(errors: FlowValidationError[]): string {
  return errors
    .map(
      (error) => `Step "${error.stepId}" consumes unknown channel(s): ${error.missing.join(', ')}`
    )
    .join('; ');
}
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectScript } from './lib/harness.js';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
import { runStepHooks } from './refactor/step-hooks.js';

type DispatchFunc = (
  op: string,
  params: any,
  ctx: Record<string, unknown>,
  type?: string,
  trace?: TraceContext,
  policy?: ReasoningStepPolicy
) => Promise<{ handled: boolean; ctx: Record<string, unknown> }>;

const dispatchCache: Record<string, DispatchFunc> = {};
const moduleCache: Record<string, any> = {};

interface RunStepsOptions {
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
}

function resolvePipelineHumanPresence(): boolean | undefined {
  if (registeredEnv('KYBERION_NON_INTERACTIVE') === '1') return false;
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  return undefined;
}

class PipelineSuspendedError extends Error {
  readonly adfControlFlow = 'suspend' as const;
  readonly suspension: PipelineRunSuspendedPayload;

  constructor(suspension: PipelineRunSuspendedPayload) {
    super(`[PIPELINE_SUSPENDED] awaiting approval ${suspension.approval_request_id}`);
    this.name = 'PipelineSuspendedError';
    this.suspension = suspension;
  }
}

function resolveParamsRecursive(params: any, ctx: any): any {
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
// engine (handleAction returned status:'failed' rather than throwing). Kept
// distinct from a plain Error so the catch block below can always rethrow it
// immediately — the underlying failure message can legitimately contain
// words like "unsupported" or "not a function", which would otherwise be
// misread as the actuator not supporting the 'pipeline' action and trigger
// an unwanted second dispatch attempt via the legacy direct-action fallback.
class ActuatorStepFailedError extends Error {}

async function loadActuatorDispatch(
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

      if (mod.actuator && typeof mod.actuator.dispatch === 'function') {
        const sdkResult = await mod.actuator.dispatch(op, params, ctx);
        if (!sdkResult.ok) {
          throw new Error(sdkResult.error || `Actuator operation failed: ${domain}:${op}`);
        }
        const output = sdkResult.output;
        result = {
          handled: true,
          ctx:
            output && typeof output === 'object' && !Array.isArray(output)
              ? (output as Record<string, unknown>)
              : { ...ctx, last_actuator_result: output },
        };
      } else if (typeof mod.dispatchDecisionOp === 'function') {
        result = await mod.dispatchDecisionOp(op, params, ctx);
      }

      if (!result.handled && typeof mod.handleAction === 'function') {
        try {
          // Resolve the sub-step kind from the op registry instead of a blind
          // 'apply' default — a transform op routed into the apply switch
          // throws UNKNOWN_OP inside the actuator (found by loop simulation).
          let resolvedType = type;
          if (!resolvedType) {
            try {
              resolvedType = determineActuatorStepType(domain, op);
            } catch {
              resolvedType = 'apply';
            }
          }
          const actionResult = await mod.handleAction({
            action: 'pipeline',
            steps: [{ type: resolvedType, op, params }],
            context: ctx,
            options: ctx.__pipeline_options,
            ...(trace ? { pipelineTrace: trace } : {}),
          });
          // A sub-pipeline that reports failed steps must fail this step —
          // "did not throw" is not success (MO-07 §14 / AR-06). Use a marker
          // Error subclass, not a plain Error: the underlying failure message
          // can legitimately contain words like "unsupported" or "not a
          // function" (e.g. "color.replace is not a function"), which the
          // catch block below would otherwise misread as a signal that the
          // actuator doesn't support the 'pipeline' action and retry via the
          // legacy direct-action fallback instead of propagating the failure.
          if (
            actionResult &&
            typeof actionResult === 'object' &&
            (actionResult as any).status === 'failed'
          ) {
            const failedEntry = Array.isArray((actionResult as any).results)
              ? (actionResult as any).results.find((entry: any) => entry.status === 'failed')
              : undefined;
            throw new ActuatorStepFailedError(
              failedEntry?.error || `Actuator sub-pipeline reported failure for ${domain}:${op}`
            );
          }
          result = {
            handled: true,
            ctx:
              actionResult && typeof actionResult === 'object'
                ? { ...ctx, ...(actionResult as Record<string, unknown>) }
                : { ...ctx, [params.export_as || 'last_action_result']: actionResult },
          };
        } catch (err: any) {
          // If the error is an actual execution failure (like SECURITY, File not found, etc.),
          // throw it immediately to trigger autonomous repair.
          // Only fallback to legacy direct action if the actuator doesn't support 'pipeline' action.
          if (
            err instanceof ActuatorStepFailedError ||
            (!err.message.toLowerCase().includes('unsupported') &&
              !err.message.toLowerCase().includes('not a function'))
          ) {
            throw err;
          }
          try {
            const resolvedParams = resolveParamsRecursive(params, ctx);
            const directResult = await mod.handleAction({
              action: op,
              params: { ...resolvedParams, context: ctx },
            });
            result = {
              handled: true,
              ctx: { ...ctx, [params.export_as || 'last_action_result']: directResult },
            };
          } catch (err2: any) {
            logger.info(
              `  [SYS_PIPELINE] Actuator fallback failed for domain: ${domain}, op: ${op}. Error: ${err2.message}`
            );
            throw err; // Critical: Re-throw to trigger autonomous repair
          }
        }
      }
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

function validatePipelineOpInput(domain: string, action: string, params: Record<string, unknown>) {
  if (domain === 'core' || domain === 'reasoning') return;
  const validation = validateOpInput(domain as any, action, params);
  if (!validation.valid) {
    const errors = 'errors' in validation ? validation.errors : ['invalid input'];
    throw new Error(`[INVALID_OP_INPUT] ${domain}:${action}: ${errors.join('; ')}`);
  }
}

function resolveLogMessage(params: Record<string, unknown>, ctx: Record<string, unknown>): string {
  const template = params.message ?? params.template ?? params.text ?? '';
  return String(resolveVars(template, ctx));
}

function resolveActuatorManifestPath(
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

async function assertPipelineStepCapabilityAvailable(
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

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchesArtifactPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const basename = path.posix.basename(normalizedPath);
  const matcher = globToRegExp(pattern.replace(/\\/g, '/'));
  return matcher.test(normalizedPath) || matcher.test(basename);
}

function resolveFragmentPath(ref: string): string {
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

function shouldUseSubagentForReasoningStep(params: Record<string, unknown>): boolean {
  if (params.use_subagent === true) return true;
  const mode = String(params.execution_mode || params.mode || '');
  return mode === 'subagent' || mode === 'delegate';
}

function coercePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runParallelBatches<T>(
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

export function formatPipelineFailure(err: unknown): {
  classification: ReturnType<typeof classifyError>;
  summary: string;
} {
  const classification = classifyError(err);
  return {
    classification,
    summary: formatClassification(classification).replace(/\n+/g, ' | '),
  };
}

function logNextActionForPipelineFailure(
  failure: ReturnType<typeof formatPipelineFailure>,
  pipelinePath: string
) {
  const nextAction = buildNextActionFromError(failure.classification, {
    source: 'pipeline',
    pipelinePath,
  });
  for (const line of formatNextAction(nextAction)) {
    logger.error(line);
  }
}

// ── AR-01 Phase A: leaf inline-op handlers ─────────────────────────────────
// Extracted verbatim from the runSteps dispatch chain (design note in
// AR-01 plan doc). Each takes the step params + context and returns the
// updated context; control-flow ops (if/foreach/include/accumulate) stay
// inline until Phase C delegates the loop to the canonical engine.

async function runInlineSystemExec(
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

async function runInlineSystemWriteFile(
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

async function runInlineSystemShell(
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

async function runInlineCoreWait(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const ms = Number(resolveVars(params.duration_ms || params.ms || 1000, ctx));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return ctx;
}

function runInlineCoreJanitor(
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

async function runInlineCoreTransform(
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

const CONTROL_ACTIONS = new Set([
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
function resolveEngineStepType(step: PipelineAdfStep): 'apply' | 'control' {
  const normalizedOp = normalizePipelineOp(step.op);
  const [domain, action] = normalizedOp.split(':');
  return domain === 'core' && CONTROL_ACTIONS.has(action) ? 'control' : 'apply';
}

function prepareEngineSteps(steps: PipelineAdfStep[]): AdfStep[] {
  return steps.map((step) => {
    const normalizedOp = normalizePipelineOp(step.op);
    const [domain, action] = normalizedOp.split(':');
    const declaredTimeoutMs =
      domain && action ? resolveActuatorOperationTimeout(domain, action) : undefined;
    const params = { ...(step.params || {}) };
    // A caller-supplied budget remains authoritative.  The governed op
    // declaration supplies a safe default so actuator-owned runners and
    // system commands do not silently run without a budget.
    if (declaredTimeoutMs !== undefined && params.timeout_ms === undefined) {
      params.timeout_ms = declaredTimeoutMs;
    }
    return {
      ...step,
      params,
      ...(declaredTimeoutMs !== undefined && step.timeout_ms === undefined
        ? { timeout_ms: declaredTimeoutMs }
        : {}),
      type: resolveEngineStepType(step),
      // The engine's native on_error handling reads step.on_error.fallback
      // directly (bypassing this function), so fallback steps need their
      // type resolved here too, or they hit the engine as untyped steps.
      ...(step.on_error?.fallback
        ? {
            on_error: {
              ...step.on_error,
              fallback: prepareEngineSteps(step.on_error.fallback) as unknown as PipelineAdfStep[],
            },
          }
        : {}),
    };
  }) as unknown as AdfStep[];
}

function parseFragmentJson(fragmentRaw: string, fragmentRef: string): any {
  try {
    return JSON.parse(fragmentRaw);
  } catch {
    /* fall through */
  }
  const repaired = tryRepairJson(fragmentRaw);
  if (repaired !== null) {
    logger.warn(`[pipeline] Auto-repaired malformed JSON in fragment: ${fragmentRef}`);
    return repaired;
  }
  throw new Error(
    `core:include: fragment at ${fragmentRef} contains invalid JSON that could not be repaired`
  );
}

function isSkip(value: unknown): value is AdfSkippedStep {
  return Boolean(value) && typeof value === 'object' && (value as any).skipped === true;
}

async function dispatchReasoningLeaf(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  stepPolicy: ReasoningStepPolicy
): Promise<Record<string, unknown>> {
  const { getReasoningBackend } = await import('@agent/core');
  const backend = getReasoningBackend();
  const resolvedInstruction =
    typeof params.instruction === 'string'
      ? resolveVars(params.instruction, ctx)
      : params.instruction;
  const resolvedContext = Array.isArray(params.context)
    ? params.context.map((item) => (typeof item === 'string' ? resolveVars(item, ctx) : item))
    : typeof params.context === 'string'
      ? resolveVars(params.context, ctx)
      : params.context || ctx;
  const routeOptions = resolvePipelineReasoningOptions(
    stepPolicy,
    ctx,
    String(params._step_id || params.step_id || 'reasoning'),
    undefined
  );
  const facetNote = resolvePipelineFacetNote(params, ctx);
  const promptVisibility = buildPipelinePromptVisibilityContext(ctx);
  const reasoningCallOptions = {
    effort: stepPolicy.effort,
    budget: stepPolicy.budget,
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
  const prompt = `Instruction: ${resolvedInstruction || 'Analyze the context.'}\nContext: ${JSON.stringify(resolvedContext)}${facetNote ? `\n\n${facetNote}` : ''}\n\n${workingPrinciples}${runtimeNote ? `\n\n${runtimeNote}` : ''}${buildReasoningPolicyNote(stepPolicy)}`;
  const preCallBudgetError = isReasoningBudgetExceeded(stepPolicy, prompt, '');
  if (preCallBudgetError) {
    throw new Error(
      `Reasoning budget exceeded${stepPolicy.budget?.approval_required ? '; approval required' : ''}: ${preCallBudgetError}`
    );
  }
  const rawResponse = shouldUseSubagentForReasoningStep(params)
    ? await backend.delegateTask(
        [String(resolvedInstruction || 'Analyze the context.'), workingPrinciples, runtimeNote]
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
    stepPolicy,
    prompt,
    String(rawResponse || '')
  );
  if (postCallBudgetError) {
    throw new Error(
      `Reasoning budget exceeded${stepPolicy.budget?.approval_required ? '; approval required' : ''}: ${postCallBudgetError}`
    );
  }
  const reasoningExportKey =
    typeof params.export_as === 'string' && params.export_as ? params.export_as : 'last_reasoning';
  return { ...ctx, [reasoningExportKey]: rawResponse };
}

/** DH-06: bind pipeline model visibility to the mission-local durable ledger. */
function buildPipelinePromptVisibilityContext(
  ctx: Record<string, unknown>
): ReasoningPromptVisibilityContext | undefined {
  const missionId = String(ctx.mission_id || process.env.MISSION_ID || '').trim();
  if (!missionId) return undefined;
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return undefined;
  const rawKnowledgeRefs = ctx.__knowledge_refs;
  const knowledgeRefs = Array.isArray(rawKnowledgeRefs)
    ? rawKnowledgeRefs.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    missionPath,
    missionId,
    ...(typeof ctx.task_id === 'string' ? { taskId: ctx.task_id } : {}),
    ...(typeof ctx.context_pack_id === 'string' ? { contextPackId: ctx.context_pack_id } : {}),
    knowledgeRefs,
    source: 'run_pipeline',
    form: 'pipeline_reasoning',
  };
}

/**
 * HA-04: route each child-script tool call back through the normal typed-op
 * dispatch. The child receives only the returned value; its intermediate
 * context never becomes the parent pipeline context.
 */
async function dispatchProgrammaticToolCall(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  rootDir: string,
  shellBin: string,
  opts: RunStepsOptions,
  stepPolicy: ReasoningStepPolicy
): Promise<Record<string, unknown>> {
  const resolveList = (value: unknown): unknown[] =>
    Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? resolveVars(item, ctx) : item))
      : [];
  const allowedOps = resolveList(params.allowed_ops ?? params.allowedOps);
  const grantedOps = resolveList(params.granted_ops ?? params.grantedOps ?? ctx.__ptc_granted_ops);
  const result = await executeProgrammaticToolCall({
    request: {
      code: String(params.code || ''),
      allowed_ops: allowedOps.map(String),
      granted_ops: grantedOps.map(String),
      ...(params.max_calls === undefined ? {} : { max_calls: Number(params.max_calls) }),
      ...(params.timeout_ms === undefined ? {} : { timeout_ms: Number(params.timeout_ms) }),
      ...(params.max_stdout_chars === undefined
        ? {}
        : { max_stdout_chars: Number(params.max_stdout_chars) }),
    },
    invoke: async ({ op, params: callParams, call_index }) => {
      const normalizedOp = normalizePipelineOp(op);
      if (normalizedOp === 'core:ptc' || normalizedOp === 'core:programmatic_tool_call') {
        throw new Error('[PTC_POLICY] Nested PTC calls are not allowed.');
      }
      const exportKey = `__ptc_result_${call_index}`;
      const callStep = {
        id: `ptc-call-${call_index}`,
        op: normalizedOp,
        type: resolveStepType({ op: normalizedOp, params: callParams }),
        params: { ...callParams, export_as: exportKey },
      } as PipelineAdfStep;
      const nextContext = await dispatchLeafOp(callStep, ctx, rootDir, shellBin, opts, stepPolicy);
      return Object.hasOwn(nextContext, exportKey) ? nextContext[exportKey] : null;
    },
    on_call: (event) => {
      opts.trace?.addEvent('ptc.op_call', {
        op: event.op,
        call_index: event.call_index,
        status: event.status,
        ...(event.error ? { error: event.error.slice(0, 500) } : {}),
      });
    },
  });
  const exportKey = String(params.export_as || 'ptc_stdout');
  return { ...ctx, [exportKey]: result.stdout };
}

/**
 * Approval grants are durable capabilities, not context-shaped hints. A leaf
 * step may proceed only when its declared approval_ref points at a decision
 * emitted by this pipeline and the persisted request binds that decision to
 * the exact effect step.
 */
function hasBoundApproval(step: PipelineAdfStep, ctx: Record<string, unknown>): boolean {
  const approvalRef =
    typeof step.budget?.approval_ref === 'string' ? step.budget.approval_ref.trim() : '';
  if (!approvalRef || !step.id) return false;
  const candidate = ctx[approvalRef];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const decision = candidate as Record<string, unknown>;
  if (
    decision.status !== 'approved' ||
    typeof decision.approval_request_id !== 'string' ||
    typeof decision.storage_channel !== 'string' ||
    typeof decision.step_id !== 'string' ||
    decision.target_step_id !== step.id
  ) {
    return false;
  }
  try {
    const request = loadApprovalRequest(decision.storage_channel, decision.approval_request_id);
    return (
      request?.status === 'approved' &&
      request.requestedByContext?.stepId === decision.step_id &&
      request.requestedByContext?.targetStepId === step.id
    );
  } catch {
    return false;
  }
}

/** All non-control ops (system:*, core:wait/run_janitor/transform/ptc, reasoning:*, actuator dispatch). */
async function dispatchLeafOp(
  step: PipelineAdfStep,
  ctx: Record<string, unknown>,
  rootDir: string,
  shellBin: string,
  opts: RunStepsOptions,
  stepPolicy: ReasoningStepPolicy
): Promise<Record<string, unknown>> {
  ensureDefaultOpPreflight();
  const normalizedOp = normalizePipelineOp(step.op);
  const [domain, action] = normalizedOp.split(':');
  const rawParams = (step.params || {}) as Record<string, unknown>;
  const _producedChannel = step.produces
    ? typeof step.produces === 'string'
      ? step.produces
      : step.produces.channel
    : undefined;
  let params =
    _producedChannel && !rawParams.export_as
      ? { ...rawParams, export_as: _producedChannel }
      : rawParams;

  const approvalGranted = hasBoundApproval(step, ctx);
  const preflight = await runOpPreflight({
    op: normalizedOp,
    params,
    context: ctx,
    source: 'pipeline',
    requiresApproval: step.budget?.approval_required === true,
    approvalGranted,
    ...(opts.hasHuman !== undefined ? { hasHuman: opts.hasHuman } : {}),
  });
  opts.trace?.addEvent('op.preflight', {
    op: normalizedOp,
    decision: preflight.decision,
    listener_count: preflight.listener_ids.length,
    guard_count: preflight.guard_ids.length,
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation ${normalizedOp} was not admitted.`}`
    );
  }
  params = preflight.input;

  if (domain === 'core' && (action === 'ptc' || action === 'programmatic_tool_call')) {
    return dispatchProgrammaticToolCall(params, ctx, rootDir, shellBin, opts, stepPolicy);
  }

  if (domain === 'system' && action === 'log') {
    logger.info(resolveLogMessage(params, ctx));
    return ctx;
  }
  if (domain === 'system' && action === 'exec') return runInlineSystemExec(params, ctx, rootDir);
  if (domain === 'system' && action === 'write_file') {
    return runInlineSystemWriteFile(params, ctx, rootDir);
  }
  if (domain === 'system' && action === 'shell') {
    return runInlineSystemShell(params, ctx, rootDir, shellBin);
  }
  if (domain === 'core' && action === 'wait') return runInlineCoreWait(params, ctx);
  if (domain === 'core' && (action === 'run_janitor' || action === 'run-janitor')) {
    return runInlineCoreJanitor(step, params, ctx);
  }
  if (domain === 'core' && action === 'transform') return runInlineCoreTransform(step, params, ctx);
  if (
    domain === 'reasoning' &&
    (action === 'analyze' || action === 'transform' || action === 'synthesize')
  ) {
    return dispatchReasoningLeaf(
      { ...params, _facets: step.facets, _step_id: step.id || step.op },
      ctx,
      stepPolicy
    );
  }

  // Emit capability.missing before dispatch so the trace records the gap
  // even if the subsequent import throws and the step is classified generically.
  if (opts.trace) {
    const mainEntry = capabilityEntry(`${domain}-actuator`);
    const altEntry = capabilityEntry(domain);
    if (!safeExistsSync(mainEntry) && !safeExistsSync(altEntry)) {
      opts.trace.addEvent('capability.missing', {
        actuator: domain,
        step_op: step.op,
        tried_entries: `${mainEntry}, ${altEntry}`,
      });
    }
  }
  validatePipelineOpInput(domain, action, params);
  await assertPipelineStepCapabilityAvailable(domain, action);
  const resolvedOperation = resolveActuatorOperation(domain, action);
  if (opts.trace) {
    opts.trace.addEvent('actuator.resolved', {
      domain,
      action,
      ...(resolvedOperation
        ? {
            actuator_id: resolvedOperation.actuatorId,
            module_path: resolvedOperation.modulePath,
            manifest_path: resolvedOperation.manifestPath,
            resolution_source: resolvedOperation.source,
            ...(resolvedOperation.timeoutMs !== undefined
              ? { timeout_ms: resolvedOperation.timeoutMs }
              : {}),
            ...(resolvedOperation.pluginId ? { plugin_id: resolvedOperation.pluginId } : {}),
          }
        : { resolution_source: 'filesystem-convention' }),
    });
  }
  const effectiveType = resolveStepType(step);
  const dispatch = await loadActuatorDispatch(domain, resolvedOperation);
  const result = await dispatch(
    action,
    {
      ...params,
      _reasoning_policy: stepPolicy,
      _facets: step.facets,
      _step_id: step.id || step.op,
    },
    ctx,
    effectiveType,
    opts.trace,
    stepPolicy
  );
  if (!result.handled) {
    throw new Error(`Unsupported pipeline op: ${step.op}`);
  }

  // CRITICAL: Safety check for source (capture) ops.
  // Resolve export key via produces > params.export_as > default.
  if (effectiveType === 'capture') {
    const exportKey = resolveExportKey(step, 'last_capture');
    const actualCtx =
      result.ctx && typeof result.ctx === 'object' && 'context' in result.ctx
        ? (result.ctx as any).context
        : result.ctx;
    const data = actualCtx[exportKey];
    if (data === undefined) {
      logger.warn(
        `  [SYS_PIPELINE] Source op ${step.op} returned no data for channel: ${exportKey}.`
      );
      throw new Error(
        `Source op ${step.op} returned no data for channel "${exportKey}". Check that the query, path, or topic is valid and that the current persona has read access. Run \`pnpm doctor\` to verify credential and capability prerequisites.`
      );
    }
  }

  if (result.ctx && typeof result.ctx === 'object' && 'context' in result.ctx) {
    return result.ctx.context as Record<string, unknown>;
  }
  return result.ctx;
}

/**
 * Recursively re-locate a step by `id` through every nested-step location the
 * engine itself recurses into (core:if then/else, core:while/loop_until/
 * retry_until_quality's pipeline body, core:foreach/parallel_foreach/
 * accumulate's do body, on_error.fallback). Matches by id ONLY — never by
 * op — because multiple steps commonly share the same op (e.g. several
 * system:shell/system:log steps in one pipeline), and matching by op alone
 * can silently substitute an unrelated step (found via live loop simulation:
 * a repair targeting a nested system:shell step re-matched an earlier,
 * already-succeeded top-level system:shell step instead).
 */
export function findStepByIdRecursive(steps: unknown, id: string): PipelineAdfStep | undefined {
  if (!Array.isArray(steps)) return undefined;
  for (const raw of steps) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as PipelineAdfStep & { on_error?: { fallback?: PipelineAdfStep[] } };
    if (s.id === id) return s;
    const params = (s.params || {}) as Record<string, unknown>;
    const found =
      findStepByIdRecursive(params.then, id) ||
      findStepByIdRecursive(params.else, id) ||
      findStepByIdRecursive(params.pipeline, id) ||
      findStepByIdRecursive(params.do, id) ||
      findStepByIdRecursive(s.on_error?.fallback, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * AR-01 Phase B: retry + autonomous-repair extracted into a higher-order
 * function that wraps a single step-execution attempt, instead of being
 * loop machinery inlined in runSteps. The canonical engine
 * (executeAdfSteps) has no built-in retry, so Phase C delegation needs
 * retry/repair as something a handler opts into, not something the engine
 * itself does — this is the shape that opt-in takes.
 */
async function runWithRepair(
  step: PipelineAdfStep,
  opts: RunStepsOptions,
  stepPolicy: ReasoningStepPolicy,
  attemptOnce: () => Promise<Record<string, unknown> | AdfSkippedStep>
): Promise<Record<string, unknown> | AdfSkippedStep> {
  let attempt = 0;
  let lastError: any = null;
  while (attempt < 2) {
    try {
      return await attemptOnce();
    } catch (err: any) {
      lastError = err;
      const failure = classifyError(err);

      // Don't repair if we already tried and the error message didn't change (prevents loops)
      if (attempt === 0 && failure.repairAction) {
        if (!opts.quiet) {
          logger.warn(
            `  [SYS_PIPELINE] Step failed: ${failure.label}. Attempting autonomous repair...`
          );
          logger.info(
            `  [SYS_PIPELINE] 修復サブエージェント実行中(数分かかることがあります) — ${step.op}`
          );
        }
        const repair = await validateAndRepairAdf(opts.pipelinePath!, 'pipeline-adf', {
          step: { op: step.op, id: step.id, params: step.params },
          failure,
          delegationOptions: {
            ...(stepPolicy.effort ? { effort: stepPolicy.effort } : {}),
            ...(stepPolicy.budget ? { budget: stepPolicy.budget } : {}),
          },
        });
        if (repair.repaired) {
          if (!opts.quiet) {
            logger.success(
              `  [SYS_PIPELINE] Repair successful. Refreshing ADF and retrying step ${step.op}...`
            );
          }
          try {
            // Reload fully from disk to get the REPAIRED definition. Search
            // recursively — the failing step may be nested inside
            // core:if/foreach/while/on_error.fallback — and match by id only.
            const refreshedPipeline = await readValidatedWorkflowAdf(opts.pipelinePath!);
            const refreshedStep = step.id
              ? findStepByIdRecursive(refreshedPipeline.steps, step.id)
              : undefined;

            if (refreshedStep) {
              // Update the step object in place so the next attempt picks it up
              step.op = refreshedStep.op;
              step.params = refreshedStep.params;
              logger.info(
                `  [SYS_PIPELINE] Step definition refreshed for ${step.id || step.op}. New path: ${(step.params as any).path}`
              );
            } else if (!opts.quiet) {
              logger.warn(
                `  [SYS_PIPELINE] Could not uniquely re-locate step "${step.id || step.op}" in the repaired ADF (missing/unmatched id) — retrying with the original step definition unchanged.`
              );
            }

            attempt++;
            continue; // Re-evaluate normalizedOp/domain/action/params with the (possibly unchanged) values
          } catch (reloadErr: any) {
            logger.warn(
              `  [SYS_PIPELINE] Failed to reload ADF after repair: ${reloadErr.message}.`
            );
          }
        }
      }
      throw lastError;
    }
  }
  throw lastError;
}

export async function runSteps(
  steps: PipelineAdfStep[],
  initialCtx: Record<string, unknown> = {},
  opts: RunStepsOptions = {}
): Promise<{
  status: 'succeeded' | 'failed';
  results: RunStepResult[];
  context: Record<string, unknown>;
}> {
  const rootDir = pathResolver.rootDir();
  const shellBin = 'bash';
  const forwardingPort: ActuatorForwardingPort = {
    forward: async (request: ActuatorForwardRequest) => {
      const targetOp = `${request.target_actuator}:${request.target_op}`;
      const targetStep = {
        op: targetOp,
        type: resolveStepType({ op: targetOp, params: request.params }),
        params: request.params,
      } as PipelineAdfStep;
      const nextContext = await dispatchLeafOp(
        targetStep,
        request.context,
        rootDir,
        shellBin,
        opts,
        normalizeReasoningPolicy(targetStep)
      );
      return {
        forwarded_to: targetOp,
        status: 'succeeded' as const,
        context: nextContext,
      };
    },
  };
  return withActuatorForwardingPort(forwardingPort, () =>
    runStepsInternal(steps, initialCtx, opts, rootDir, shellBin)
  );
}

async function runStepsInternal(
  steps: PipelineAdfStep[],
  initialCtx: Record<string, unknown>,
  opts: RunStepsOptions,
  rootDir: string,
  shellBin: string
): Promise<{
  status: 'succeeded' | 'failed';
  results: RunStepResult[];
  context: Record<string, unknown>;
}> {
  const results: RunStepResult[] = [];
  const totalTopLevelSteps = steps.length;
  const stepStartTimes = new Map<number, number>();
  const stepRefStack: PipelineAdfStep[] = [];
  let includeStack: ReadonlySet<string> = opts._includeStack ?? new Set<string>();
  let lastKnownCtx: Record<string, unknown> = initialCtx;

  // core:include mutates includeStack around its own nested body only; every
  // other control op just needs a nested run + throw-on-failure, so it's
  // shared here to avoid repeating the "run nested, check status, throw" triple.
  const dispatchControlOp = async (
    rawOp: string,
    rawParams: any,
    ctx: Record<string, unknown>,
    runNestedSteps: (
      nested: AdfStep[],
      seedCtx?: Record<string, unknown>
    ) => Promise<AdfRunResult<Record<string, unknown>>>
  ): Promise<Record<string, unknown> | AdfSkippedStep> => {
    const normalizedOp = normalizePipelineOp(rawOp);
    const [, action] = normalizedOp.split(':');
    const params = (rawParams || {}) as Record<string, any>;
    const currentStep = stepRefStack[stepRefStack.length - 1];

    if (action === 'judge_route') {
      const judge = (params.judge || {}) as Record<string, unknown>;
      const exportKey = String(
        params.export_as ||
          (currentStep?.produces
            ? typeof currentStep.produces === 'string'
              ? currentStep.produces
              : currentStep.produces.channel
            : 'judge_route')
      );
      const verdictKey = String(params.verdict_as || 'judge_verdict');
      const fixtureVerdict =
        params.fixture === true && params.verdict && typeof params.verdict === 'object'
          ? (resolveVars(params.verdict, ctx) as Record<string, unknown>)
          : undefined;
      const schemaRef = String(judge.schema_ref || params.schema_ref || 'judge_route_verdict');
      const verdict = fixtureVerdict
        ? fixtureVerdict
        : await delegateStructured(
            getReasoningBackend(),
            [
              String(
                resolveVars(
                  judge.prompt ||
                    judge.instruction_ref ||
                    params.prompt ||
                    'Classify the current pipeline context.',
                  ctx
                )
              ),
              `Return a route verdict compatible with schema_ref=${schemaRef}.`,
              `Inputs:\n${JSON.stringify(resolveVars(judge.inputs ?? ctx, ctx))}`,
            ].join('\n\n'),
            z
              .object({
                label: z.string().min(1),
                reason: z.string().optional(),
                value: z.unknown().optional(),
              })
              .passthrough(),
            { context: `pipeline:judge_route:${currentStep?.id || exportKey}`, maxRetries: 2 }
          );
      const routes = Array.isArray(params.routes)
        ? (params.routes as Array<{
            when?: Record<string, unknown>;
            next: string;
            reason?: string;
          }>)
        : [];
      const decision = selectJudgeRoute(
        verdict as Record<string, unknown>,
        routes,
        (params.on_no_match as 'abort' | 'complete' | 'continue' | undefined) || 'abort'
      );
      opts.trace?.addEvent('judge.route_selected', {
        step_id: currentStep?.id || rawOp,
        route_index: decision.selection.route_index,
        next: decision.selection.next,
        matched: decision.selection.matched,
        reason: decision.selection.reason,
        schema_ref: schemaRef,
        source: fixtureVerdict ? 'fixture' : 'reasoning_backend',
      });
      if (decision.selection.next === 'ABORT') {
        throw new Error(`[JUDGE_ROUTE_ABORT] ${decision.selection.reason}`);
      }
      const history = Array.isArray(ctx.__judge_route_history)
        ? [...ctx.__judge_route_history.map(String)]
        : [];
      if (decision.selection.next !== 'COMPLETE' && decision.selection.next !== 'CONTINUE') {
        const next = decision.selection.next;
        const currentIndex = currentStep?.id
          ? steps.findIndex((candidate) => candidate.id === currentStep.id)
          : -1;
        const targetIndex = steps.findIndex((candidate) => candidate.id === next);
        if (currentIndex >= 0 && targetIndex >= 0 && targetIndex <= currentIndex) {
          throw new Error(
            `[JUDGE_ROUTE_BACK_EDGE_UNSUPPORTED] route from '${currentStep?.id}' to '${next}' would rewind a linear pipeline`
          );
        }
        const nextHistory = [...history, next];
        const cycle = detectRouteCycle(
          nextHistory,
          resolveMaxRouteHops(totalTopLevelSteps, params.max_route_hops)
        );
        if (cycle.detected) {
          throw new Error(`[JUDGE_ROUTE_LOOP] ${cycle.reason}`);
        }
        return {
          ...ctx,
          [verdictKey]: verdict,
          [exportKey]: decision.selection,
          __judge_route_history: nextHistory,
          __pipeline_route_next: next,
        };
      }
      const nextContext = {
        ...ctx,
        [verdictKey]: verdict,
        [exportKey]: decision.selection,
        __judge_route_history: history,
      };
      if (decision.selection.next === 'COMPLETE') {
        return { ...nextContext, __adf_terminal: true };
      }
      return nextContext;
    }

    if (action === 'await_decision') {
      const approval = (params.approval || {}) as Record<string, unknown>;
      const stepId = currentStep?.id;
      if (!stepId) throw new Error('core:await_decision requires a step id for durable resume');
      const targetStepId =
        typeof params.approval_for === 'string' && params.approval_for.trim()
          ? params.approval_for.trim()
          : undefined;
      const storageChannel = String(params.storage_channel || 'pipeline-approval');
      const onTimeout = (['abort', 'deny', 'escalate'] as const).includes(
        params.on_timeout as 'abort' | 'deny' | 'escalate'
      )
        ? (params.on_timeout as 'abort' | 'deny' | 'escalate')
        : 'abort';
      const suspended = opts.resumeState?.suspended;
      if (suspended && suspended.step_id === stepId) {
        const existing = loadApprovalRequest(
          suspended.storage_channel,
          suspended.approval_request_id
        );
        if (existing?.status === 'approved') {
          return {
            ...ctx,
            [String(params.export_as || 'decision')]: {
              status: 'approved',
              approval_request_id: existing.id,
              storage_channel: suspended.storage_channel,
              step_id: existing.requestedByContext?.stepId || stepId,
              ...(existing.requestedByContext?.targetStepId
                ? { target_step_id: existing.requestedByContext.targetStepId }
                : {}),
              decided_by: existing.decidedBy,
            },
          };
        }
        if (existing?.status === 'rejected' || existing?.status === 'cancelled') {
          throw new Error(
            `[AWAIT_DECISION_DENIED] approval ${suspended.approval_request_id} is ${existing.status}`
          );
        }
        const expired = suspended.timeout_at && Date.parse(suspended.timeout_at) <= Date.now();
        if (expired || (existing && isApprovalRequestExpired(existing))) {
          if (suspended.on_timeout === 'deny') {
            return {
              ...ctx,
              [String(params.export_as || 'decision')]: {
                status: 'denied',
                timed_out: true,
                approval_request_id: suspended.approval_request_id,
              },
            };
          }
          if (suspended.on_timeout === 'escalate') {
            const escalationTimeoutMs = coercePositiveInt(params.escalation_timeout_ms, 86_400_000);
            const escalation = createApprovalRequest('mission_controller', {
              channel: suspended.storage_channel,
              threadTs: String(params.thread_ts || `${stepId}:escalation`),
              correlationId: `pipeline:${opts.runId || 'pending'}:${stepId}:escalation`,
              requestedBy: `pipeline:${opts.runId || 'pending'}`,
              kind: 'mission_gate',
              expiresAt: new Date(Date.now() + escalationTimeoutMs).toISOString(),
              requestedByContext: {
                surface: 'system',
                actorId: `pipeline:${opts.runId || 'pending'}`,
                actorRole: 'pipeline',
                stepId,
                ...(existing?.requestedByContext?.targetStepId
                  ? { targetStepId: existing.requestedByContext.targetStepId }
                  : {}),
                ...(process.env.MISSION_ID ? { missionId: process.env.MISSION_ID } : {}),
              },
              source: {
                ...(process.env.MISSION_ID ? { missionId: process.env.MISSION_ID } : {}),
                agentId: registeredEnv('KYBERION_AGENT_ID') || 'pipeline-orchestrator',
              },
              draft: {
                title: `Escalated pipeline decision: ${stepId}`,
                summary: `The original decision ${suspended.approval_request_id} timed out and requires escalation.`,
                severity: 'high',
              },
              justification: {
                reason: 'TAKT await_decision timeout escalation',
                impactSummary: `Original approval ${suspended.approval_request_id} expired without a decision.`,
              },
            });
            throw new PipelineSuspendedError({
              step_id: stepId,
              approval_request_id: escalation.id,
              storage_channel: suspended.storage_channel,
              on_timeout: 'abort',
              timeout_at: escalation.expiresAt,
              reason: `escalated from expired approval ${suspended.approval_request_id}`,
            });
          }
          throw new Error(`[AWAIT_DECISION_TIMEOUT] on_timeout=${suspended.on_timeout}`);
        }
        throw new PipelineSuspendedError(suspended);
      }
      if (registeredEnv('KYBERION_NON_INTERACTIVE') === '1' && params.non_interactive !== 'allow') {
        throw new Error('[AWAIT_DECISION_DENIED] non-interactive execution defaults to deny');
      }
      const timeoutMs = coercePositiveInt(params.timeout_ms ?? params.timeout, 86_400_000);
      const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();
      const record = createApprovalRequest('mission_controller', {
        channel: storageChannel,
        threadTs: String(params.thread_ts || stepId),
        correlationId: `pipeline:${opts.runId || 'pending'}:${stepId}`,
        requestedBy: `pipeline:${opts.runId || 'pending'}`,
        kind: 'mission_gate',
        expiresAt: timeoutAt,
        requestedByContext: {
          surface: 'system',
          actorId: `pipeline:${opts.runId || 'pending'}`,
          actorRole: 'pipeline',
          stepId,
          ...(targetStepId ? { targetStepId } : {}),
          ...(process.env.MISSION_ID ? { missionId: process.env.MISSION_ID } : {}),
        },
        source: {
          ...(process.env.MISSION_ID ? { missionId: process.env.MISSION_ID } : {}),
          agentId: registeredEnv('KYBERION_AGENT_ID') || 'pipeline-orchestrator',
        },
        draft: {
          title: String(approval.title || `Pipeline decision: ${stepId}`),
          summary: String(
            approval.summary || params.summary || 'Pipeline execution requires a human decision.'
          ),
          details: typeof approval.details === 'string' ? approval.details : undefined,
          severity:
            approval.severity === 'high' ? 'high' : approval.severity === 'low' ? 'low' : 'medium',
        },
        justification: {
          reason: 'TAKT await_decision control stage',
          impactSummary: String(
            approval.summary ||
              params.summary ||
              'Pipeline execution is suspended until a decision arrives.'
          ),
        },
      });
      throw new PipelineSuspendedError({
        step_id: stepId,
        approval_request_id: record.id,
        storage_channel: storageChannel,
        on_timeout: onTimeout,
        timeout_at: timeoutAt,
        reason: String(approval.summary || params.summary || 'human decision required'),
      });
    }

    const runBody = async (
      body: PipelineAdfStep[],
      seedCtx: Record<string, unknown>,
      failureLabel: string
    ) => {
      const nested = await runNestedSteps(prepareEngineSteps(body), seedCtx);
      if (nested.status === 'failed') {
        throw new Error(nested.results.find((r) => r.status === 'failed')?.error || failureLabel);
      }
      return nested;
    };

    if (action === 'if') {
      const conditionResult = evaluateCondition(params.condition, ctx);
      const branch = conditionResult ? params.then : params.else;
      if (Array.isArray(branch)) {
        const nested = await runBody(branch, ctx, 'core:if branch failed');
        return nested.context;
      }
      if (!conditionResult) {
        return skipAdfStep(
          ctx,
          'core:if condition evaluated to false and no else branch was provided'
        );
      }
      return ctx;
    }

    if (action === 'switch') {
      const cases = Array.isArray(params.cases) ? params.cases : [];
      const selected = cases.find((entry: any) =>
        evaluateCondition(entry.when ?? entry.condition, ctx)
      );
      const branch = selected?.steps ?? selected?.pipeline ?? selected?.then ?? params.default;
      if (Array.isArray(branch)) {
        const nested = await runBody(branch, ctx, 'core:switch branch failed');
        return nested.context;
      }
      return skipAdfStep(ctx, 'core:switch selected no case and no default branch');
    }

    if (action === 'while' || action === 'loop_until' || action === 'retry_until_quality') {
      const body = Array.isArray(params.pipeline)
        ? (params.pipeline as PipelineAdfStep[])
        : undefined;
      if (!body) throw new Error(`${rawOp} requires "pipeline" param`);
      const maxIterations = coercePositiveInt(params.max_iterations ?? params.maxIterations, 1);
      const condition = params.condition ?? params.until ?? params.quality_condition;
      const exportKey = resolveExportKey(
        { op: rawOp, params } as PipelineAdfStep,
        'last_loop_result'
      );
      const iterations: Array<{
        iteration: number;
        context: Record<string, unknown>;
        results: RunStepResult[];
      }> = [];
      let loopCount = 0;
      let workingCtx = ctx;
      while (loopCount < maxIterations) {
        if (condition !== undefined && action !== 'retry_until_quality') {
          if (!evaluateCondition(condition, workingCtx)) break;
        }
        const nested = await runBody(body, workingCtx, `${rawOp} iteration failed`);
        workingCtx = nested.context;
        iterations.push({
          iteration: loopCount + 1,
          context: nested.context,
          results: nested.results as RunStepResult[],
        });
        loopCount += 1;
        if (action === 'retry_until_quality') {
          const verdict = String((workingCtx as any).verdict || (workingCtx as any).quality || '');
          if (verdict === 'ok' || verdict === 'pass' || verdict === 'passed') break;
        }
        if (condition !== undefined && action === 'retry_until_quality') {
          if (!evaluateCondition(condition, workingCtx)) break;
        }
      }
      if (loopCount === 0) {
        return skipAdfStep(ctx, 'core:while condition evaluated to false before execution');
      }
      return {
        ...workingCtx,
        [exportKey]: { iterations: loopCount, history: iterations, final_context: workingCtx },
      };
    }

    if (action === 'foreach') {
      const items = resolveVars(params.items, ctx);
      const subSteps = params.do as PipelineAdfStep[];
      if (!Array.isArray(items) || !Array.isArray(subSteps)) return ctx;
      const itemName = (params.as as string) || 'item';
      const originalItemValue = (ctx as any)[itemName];
      let workingCtx = ctx;
      for (const item of items) {
        const loopCtx = { ...workingCtx, [itemName]: item };
        const nested = await runBody(subSteps, loopCtx, 'core:foreach item failed');
        workingCtx = { ...nested.context };
        if (originalItemValue === undefined) delete (workingCtx as any)[itemName];
        else (workingCtx as any)[itemName] = originalItemValue;
      }
      return workingCtx;
    }

    if (action === 'parallel_foreach') {
      const itemsFrom = params.items_from as Record<string, unknown> | undefined;
      let items = resolveVars(params.items, ctx);
      if (itemsFrom && !Array.isArray(items)) {
        const poolRef = typeof itemsFrom.pool_ref === 'string' ? itemsFrom.pool_ref : undefined;
        const pool = poolRef ? (resolveVars(`{{${poolRef}}}`, ctx) as unknown) : undefined;
        if (!Array.isArray(pool)) {
          throw new Error('[PARALLEL_POOL_INVALID] items_from.pool_ref must resolve to an array');
        }
        const selection = itemsFrom.selection as Record<string, unknown> | undefined;
        const fixture = selection?.fixture;
        if (Array.isArray(fixture)) {
          const indices = fixture.map((entry) => Number(entry));
          items = indices.every(
            (index) => Number.isInteger(index) && index >= 0 && index < pool.length
          )
            ? indices.map((index) => pool[index])
            : fixture;
        } else if (selection?.judge && typeof selection.judge === 'object') {
          const judge = selection.judge as Record<string, unknown>;
          const selected = await delegateStructured(
            getReasoningBackend(),
            [
              String(judge.prompt || 'Select the pool items that satisfy the current task.'),
              `Pool:\n${JSON.stringify(pool)}`,
              'Return zero-based selected_indices only; do not invent indices.',
            ].join('\n\n'),
            z.object({ selected_indices: z.array(z.number().int().nonnegative()) }).strict(),
            {
              context: `pipeline:parallel_foreach:selection:${currentStep?.id || rawOp}`,
              maxRetries: 2,
            }
          );
          const indices = selected.selected_indices;
          if (
            new Set(indices).size !== indices.length ||
            indices.some((index) => index < 0 || index >= pool.length)
          ) {
            throw new Error(
              '[PARALLEL_SELECTION_INVALID] judge selected an out-of-range or duplicate pool index'
            );
          }
          items = indices.map((index) => pool[index]);
        } else {
          items = pool;
        }
      }
      const subSteps = params.do as PipelineAdfStep[];
      if (!Array.isArray(items) || !Array.isArray(subSteps)) return ctx;
      const itemName = (params.as as string) || 'item';
      const concurrency = coercePositiveInt(params.concurrency ?? params.parallelism, 2);
      const exportKey = resolveExportKey(
        { op: rawOp, params } as PipelineAdfStep,
        'last_parallel_foreach'
      );
      const mergePolicy =
        params.merge === 'last' || params.merge === 'namespace' || params.merge === 'collect'
          ? params.merge
          : 'collect';
      const originalItemValue = (ctx as any)[itemName];
      const originalSharedCtx = { ...ctx };
      const preparedBody = prepareEngineSteps(subSteps);
      const perItemContexts: Array<Record<string, unknown>> = [];
      const perItemOutputs: Array<{
        index: number;
        item: unknown;
        context: Record<string, unknown>;
        results: RunStepResult[];
      }> = [];
      await runParallelBatches(items, concurrency, async (item, index) => {
        const loopCtx = { ...originalSharedCtx, [itemName]: item };
        const nested = await runNestedSteps(preparedBody, loopCtx);
        if (nested.status === 'failed') {
          throw new Error(
            `parallel_foreach item ${index + 1} failed: ${nested.results.find((r) => r.status === 'failed')?.error || 'nested failure'}`
          );
        }
        perItemContexts[index] = nested.context;
        perItemOutputs[index] = {
          index,
          item,
          context: nested.context,
          results: nested.results as RunStepResult[],
        };
      });
      let workingCtx: Record<string, unknown> = { ...ctx, [exportKey]: perItemOutputs };
      if (originalItemValue === undefined) delete (workingCtx as any)[itemName];
      else (workingCtx as any)[itemName] = originalItemValue;
      if (mergePolicy === 'namespace') {
        workingCtx = {
          ...workingCtx,
          [exportKey]: Object.fromEntries(
            perItemContexts.map((itemContext, index) => [String(index), itemContext])
          ),
        };
      } else if (mergePolicy === 'last' && perItemContexts.length > 0) {
        workingCtx = { ...workingCtx, ...perItemContexts[perItemContexts.length - 1] };
      }
      return workingCtx;
    }

    if (action === 'team_lead') {
      const subSteps = params.do as PipelineAdfStep[];
      if (!Array.isArray(subSteps)) {
        throw new Error('[TEAM_LEAD_INVALID] team_lead requires params.do');
      }
      let tasks = resolveVars(params.tasks, ctx);
      if (!Array.isArray(tasks)) {
        const fixtureTasks = params.fixture_tasks;
        if (Array.isArray(fixtureTasks)) tasks = fixtureTasks;
        else {
          const plan = await delegateStructured(
            getReasoningBackend(),
            String(
              params.instruction || 'Decompose the current context into bounded parallel tasks.'
            ) + `\nContext:\n${JSON.stringify(params.context || ctx)}`,
            z.object({ tasks: z.array(z.record(z.string(), z.unknown())).min(1) }),
            { context: `pipeline:team_lead:${currentStep?.id || rawOp}`, maxRetries: 2 }
          );
          tasks = plan.tasks;
        }
      }
      const itemName = typeof params.as === 'string' ? params.as : 'task';
      const concurrency = Math.min(
        coercePositiveInt(params.max_concurrency ?? params.concurrency, 2),
        3
      );
      const exportKey = resolveExportKey(
        { op: rawOp, params } as PipelineAdfStep,
        'last_team_lead'
      );
      const outputs: Array<{
        index: number;
        item: unknown;
        context: Record<string, unknown>;
        results: RunStepResult[];
      }> = [];
      await runParallelBatches(tasks, concurrency, async (task, index) => {
        const nested = await runBody(
          subSteps,
          { ...ctx, [itemName]: task },
          'core:team_lead worker failed'
        );
        if (nested.status === 'failed') throw new Error(`team_lead task ${index + 1} failed`);
        outputs[index] = {
          index,
          item: task,
          context: nested.context,
          results: nested.results as RunStepResult[],
        };
      });
      return { ...ctx, [exportKey]: { tasks, outputs, max_concurrency: concurrency } };
    }

    if (action === 'parallel_calls') {
      // KD-07: resource-claim declaring tool-call scheduler, wired here as
      // the adf-engine batch-execution path for a single step that fans out
      // into several heterogeneous tool/op calls. Different layer than
      // `core:parallel_foreach` above: parallel_foreach runs ONE fixed body
      // over N data items; parallel_calls runs N (possibly different) ops
      // once each, parallelizing only the ones whose declared resource
      // claims never conflict (see tool-call-scheduler.ts). An op with no
      // `accesses` declaration is conservative — `{kind:'all'}` — which
      // degrades the WHOLE batch to today's fully-serial behavior.
      const callSteps = params.calls as PipelineAdfStep[];
      if (!Array.isArray(callSteps) || callSteps.length === 0) return ctx;
      const preparedCalls = prepareEngineSteps(callSteps);
      const exportKey = resolveExportKey(
        { op: rawOp, params } as PipelineAdfStep,
        'last_parallel_calls'
      );

      const scheduled = preparedCalls.map((step, index) => {
        const normalizedOp = normalizePipelineOp(step.op);
        const [domain, opAction] = normalizedOp.split(':');
        let resolvedParams: Record<string, unknown> = (step.params || {}) as Record<
          string,
          unknown
        >;
        try {
          resolvedParams = resolveVars(step.params, ctx) as Record<string, unknown>;
        } catch {
          /* unresolvable templates — resolve claims from the raw params instead */
        }
        // Control ops (nested core:if/core:while/... ) have no filesystem
        // footprint of their own to declare — stay conservative for them.
        const claims: ResourceClaim[] =
          domain === 'core'
            ? [{ kind: 'all' }]
            : resolveOpAccessClaims(domain as OpInputDomain, opAction, resolvedParams);
        return {
          claims,
          run: async (): Promise<Record<string, unknown>> => {
            const nested = await runNestedSteps([step], ctx);
            if (nested.status === 'failed') {
              throw new Error(
                nested.results.find((r) => r.status === 'failed')?.error ||
                  `core:parallel_calls call ${index + 1} (${step.op}) failed`
              );
            }
            return nested.context;
          },
        };
      });

      const settled = await runToolCallBatch(scheduled);
      const perCallResults = settled.map((entry, index) => ({
        index,
        op: preparedCalls[index].op,
        status: entry.status,
        ...(entry.status === 'rejected'
          ? { error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) }
          : {}),
      }));
      const firstFailure = settled.find((entry) => entry.status === 'rejected');
      if (firstFailure && firstFailure.status === 'rejected') {
        throw new Error(
          firstFailure.reason instanceof Error
            ? firstFailure.reason.message
            : String(firstFailure.reason)
        );
      }
      // Merge each call's context contribution in REQUEST order (later calls
      // win on key collisions), exactly like sequential execution would —
      // regardless of which call actually finished first in wall-clock time.
      let mergedCtx: Record<string, unknown> = { ...ctx };
      for (const entry of settled) {
        if (entry.status === 'fulfilled') {
          mergedCtx = { ...mergedCtx, ...(entry.value as Record<string, unknown>) };
        }
      }
      return { ...mergedCtx, [exportKey]: perCallResults };
    }

    if (action === 'accumulate') {
      const items = resolveVars(params.items, ctx);
      const subSteps = params.do as PipelineAdfStep[];
      if (!Array.isArray(items)) throw new Error('core:accumulate requires "items" to be an array');
      if (!Array.isArray(subSteps)) throw new Error('core:accumulate requires "do" pipeline steps');
      const itemName = (params.as as string) || 'item';
      const collectKey = String(params.collect_as || params.export_as || 'result');
      const exportKey = resolveExportKey(
        { op: rawOp, params } as PipelineAdfStep,
        'last_accumulate'
      );
      const originalItemValue = (ctx as any)[itemName];
      const originalSharedCtx = { ...ctx };
      const targetCount = coercePositiveInt(
        params.target_count ?? params.targetCount,
        items.length
      );
      const maxIterations = coercePositiveInt(
        params.max_iterations ?? params.maxIterations,
        items.length
      );
      const dryStreakLimit = coercePositiveInt(params.dry_streak_limit ?? params.dryStreakLimit, 2);
      const seen = new Set<string>();
      const collected: Array<{
        index: number;
        item: unknown;
        value: unknown;
        context: Record<string, unknown>;
        results: RunStepResult[];
      }> = [];
      let dryStreak = 0;
      let loopCount = 0;
      for (const [index, item] of items.entries()) {
        if (loopCount >= maxIterations) break;
        if (collected.length >= targetCount) break;
        const loopCtx = { ...originalSharedCtx, [itemName]: item };
        const nested = await runBody(subSteps, loopCtx, `accumulate item ${index + 1} failed`);
        const candidateValue = (nested.context as any)[collectKey] ?? nested.context ?? item;
        const fingerprint = (() => {
          try {
            return JSON.stringify(candidateValue);
          } catch {
            return String(candidateValue);
          }
        })();
        loopCount += 1;
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint);
          collected.push({
            index,
            item,
            value: candidateValue,
            context: nested.context,
            results: nested.results as RunStepResult[],
          });
          dryStreak = 0;
        } else {
          dryStreak += 1;
        }
        if (dryStreak >= dryStreakLimit) break;
      }
      let workingCtx: Record<string, unknown> = {
        ...ctx,
        [exportKey]: {
          collected,
          iterations: loopCount,
          dry_streak: dryStreak,
          target_count: targetCount,
          final_context: ctx,
        },
      };
      if (originalItemValue === undefined) delete (workingCtx as any)[itemName];
      else (workingCtx as any)[itemName] = originalItemValue;
      return workingCtx;
    }

    if (action === 'include') {
      const fragmentRef = String(resolveVars(params.fragment || '', ctx));
      if (!fragmentRef) throw new Error('core:include requires "fragment" param');
      const fragmentPath = resolveFragmentPath(fragmentRef);
      if (!safeExistsSync(fragmentPath)) {
        throw new Error(
          `core:include: fragment not found: ${fragmentRef} (resolved: ${fragmentPath})`
        );
      }
      if (includeStack.has(fragmentPath)) {
        throw new Error(
          `core:include: circular reference detected — ${fragmentRef} is already in the include chain`
        );
      }
      const fragmentRaw = String(safeReadFile(fragmentPath, { encoding: 'utf8' }));
      const fragmentJson = parseFragmentJson(fragmentRaw, fragmentRef);
      const fragmentSteps: PipelineAdfStep[] = (fragmentJson.steps || []).map((s: any) => ({
        ...s,
        params: s.params || {},
      }));
      const fragmentContext: Record<string, unknown> =
        fragmentJson.context && typeof fragmentJson.context === 'object'
          ? Object.fromEntries(
              Object.entries(fragmentJson.context as Record<string, unknown>).map(([k, v]) => [
                k,
                typeof v === 'string' ? resolveVars(v, ctx) : v,
              ])
            )
          : {};
      const inlineCtx: Record<string, unknown> =
        params.context && typeof params.context === 'object'
          ? Object.fromEntries(
              Object.entries(params.context as Record<string, unknown>).map(([k, v]) => [
                k,
                typeof v === 'string' ? resolveVars(v, ctx) : v,
              ])
            )
          : {};
      const previousStack = includeStack;
      includeStack = new Set([...previousStack, fragmentPath]);
      try {
        const nested = await runBody(
          fragmentSteps,
          { ...fragmentContext, ...ctx, ...inlineCtx },
          `core:include fragment failed: ${fragmentRef}`
        );
        const exportKey =
          typeof params.export_as === 'string' && params.export_as ? params.export_as : undefined;
        if (!exportKey) return nested.context;
        return {
          ...nested.context,
          [exportKey]: {
            status: nested.status,
            results: nested.results,
            context: nested.context,
          },
        };
      } finally {
        includeStack = previousStack;
      }
    }

    throw new Error(`[UNKNOWN_TYPE] Unknown control step op: ${rawOp}`);
  };

  const runStepWithLifecycle = async (
    ctx: Record<string, unknown>,
    runNestedSteps?: (
      nested: AdfStep[],
      seedCtx?: Record<string, unknown>
    ) => Promise<AdfRunResult<Record<string, unknown>>>
  ): Promise<Record<string, unknown> | AdfSkippedStep> => {
    const step = stepRefStack[stepRefStack.length - 1];
    const stepPolicy = normalizeReasoningPolicy(step);

    // GE-04: completed nodes are terminal successes on resume. The caller
    // restored their declared channels into the seed context before entering
    // the engine, so this path never dispatches an actuator or repair.
    if (step.id && opts.resumeState?.completed_nodes.has(step.id)) {
      return { ...ctx };
    }

    // A judge_route target is a declarative step id, not an instruction to
    // execute arbitrary code. Until the selected target is reached, steps in
    // the linear frontier are skipped. The selected step consumes the marker
    // so a later step cannot accidentally inherit an old decision.
    const selectedRouteTarget = ctx.__pipeline_route_next;
    if (selectedRouteTarget && normalizePipelineOp(step.op) !== 'core:judge_route') {
      if (step.id !== selectedRouteTarget) {
        return skipAdfStep(ctx, `judge_route selected ${selectedRouteTarget}`);
      }
      const { __pipeline_route_next: _routeNext, ...withoutRouteMarker } = ctx;
      ctx = withoutRouteMarker;
    }

    if (step.hooks?.before?.length) {
      const decision = await runStepHooks(step.hooks.before, ctx, 'before', loadActuatorDispatch);
      if (decision === 'abort') throw new Error('aborted by before hook');
      if (decision === 'skip') return skipAdfStep(ctx, 'skipped by before hook');
    }

    const dispatch = (): Promise<Record<string, unknown> | AdfSkippedStep> =>
      runNestedSteps
        ? dispatchControlOp(step.op, step.params, ctx, runNestedSteps)
        : dispatchLeafOp(step, ctx, rootDir, shellBin, opts, stepPolicy);

    const outcome = step.on_error
      ? await dispatch()
      : await runWithRepair(step, opts, stepPolicy, dispatch);
    if (isSkip(outcome)) return outcome;

    if (step.hooks?.after?.length) {
      const afterDecision = await runStepHooks(
        step.hooks.after,
        outcome as Record<string, unknown>,
        'after',
        loadActuatorDispatch
      );
      if (afterDecision === 'abort') throw new Error('aborted by after hook');
    }
    return outcome;
  };

  const handlers: AdfStepHandlers = {
    // Never routed here: resolveEngineStepType only produces 'apply' | 'control'.
    capture: async (_op, _params, ctx) => ctx,
    transform: async (_op, _params, ctx) => ctx,
    apply: async (_op, _params, ctx) => runStepWithLifecycle(ctx),
    control: async (_op, _params, ctx, runNestedSteps) => runStepWithLifecycle(ctx, runNestedSteps),
  };

  const eventStream = getDefaultWorkerEventStream();
  const hooks: AdfStepHooks = {
    beforeStep: (rawStep, stepNumber) => {
      const step = rawStep as unknown as PipelineAdfStep;
      stepRefStack.push(step);
      eventStream.emit('step_begin', {
        op: step.op,
        step_number: stepNumber,
        step_id: step.id || step.op,
      });
      const stepPolicy = normalizeReasoningPolicy(step);
      const stepTraceBase = {
        step_index: results.length,
        step_id: step.id || step.op,
        op: step.op,
        ...(step.role ? { step_role: step.role } : step.type ? { step_type: step.type } : {}),
        ...summarizeReasoningPolicy(stepPolicy),
      };
      stepStartTimes.set(stepNumber, Date.now());
      opts.trace?.startSpan(step.op, { ...stepTraceBase });
      opts.trace?.addEvent('step.started', stepTraceBase);
      if (!opts.quiet) {
        logger.info(`[step ${stepNumber}/${totalTopLevelSteps}] ${step.op} …`);
      }
    },
    afterStep: async (rawStep, stepNumber, ctx, outcome) => {
      lastKnownCtx = ctx;
      const step = rawStep as unknown as PipelineAdfStep;
      const normalizedOp = normalizePipelineOp(String(step.op));
      const startedAtMs = stepStartTimes.get(stepNumber) ?? Date.now();
      stepStartTimes.delete(stepNumber);
      const durationMs = Date.now() - startedAtMs;
      const stepPolicy = normalizeReasoningPolicy(step);
      const stepTraceBase = {
        step_index: results.length,
        step_id: step.id || step.op,
        op: normalizedOp,
        ...(step.role ? { step_role: step.role } : step.type ? { step_type: step.type } : {}),
        ...summarizeReasoningPolicy(stepPolicy),
      };
      if (outcome.status === 'success' && step.report) {
        ctx = await runPipelineReportPhase(step, ctx, opts.trace);
        lastKnownCtx = ctx;
      }
      const failureInfo =
        outcome.status === 'failed' && outcome.error
          ? formatPipelineFailure(outcome.error)
          : undefined;
      const eventName =
        outcome.status === 'success'
          ? 'step.completed'
          : outcome.status === 'failed'
            ? 'step.failed'
            : outcome.status === 'skipped'
              ? 'step.skipped'
              : 'step.recovered';
      opts.trace?.addEvent(eventName, {
        ...stepTraceBase,
        status: outcome.status,
        duration_ms: durationMs,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(failureInfo
          ? {
              error_category: failureInfo.classification.category,
              error_rule_id: failureInfo.classification.ruleId,
            }
          : {}),
      });
      eventStream.emit('step_end', {
        op: normalizedOp,
        step_number: stepNumber,
        step_id: step.id || step.op,
        status: outcome.status,
        duration_ms: durationMs,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      let postToolHookOutcome: { resultPatch: Record<string, unknown> };
      try {
        postToolHookOutcome = await fireLifecycleHooks(
          getDefaultLifecycleHookEngine(),
          outcome.status === 'failed' ? 'post_tool_use_failure' : 'post_tool_use',
          {
            matcher_value: normalizedOp,
            op: normalizedOp,
            status: outcome.status,
            result: outcome,
            ...(outcome.error ? { error: outcome.error } : {}),
          }
        );
      } catch (error) {
        logger.error(
          `[LIFECYCLE_HOOK] post-tool hook telemetry failed: ${error instanceof Error ? error.message : String(error)}`
        );
        postToolHookOutcome = { resultPatch: {} };
      }
      if (Object.keys(postToolHookOutcome.resultPatch).length > 0) {
        ctx = { ...ctx, ...postToolHookOutcome.resultPatch };
        lastKnownCtx = ctx;
        opts.trace?.addEvent('tool.result_patched', {
          ...stepTraceBase,
          patch_keys: Object.keys(postToolHookOutcome.resultPatch).sort().join(','),
        });
      }
      if (!opts.quiet && (outcome.status === 'success' || outcome.status === 'failed')) {
        logger.info(
          `[step ${stepNumber}/${totalTopLevelSteps}] ${normalizedOp} ${outcome.status} in ${Math.round(durationMs / 1000)}s`
        );
      }
      results.push({
        op: normalizedOp,
        status: outcome.status,
        ...(outcome.error && outcome.status === 'failed' ? { error: outcome.error } : {}),
      });
      if (opts.runJournal && step.id && !opts.resumeState?.completed_nodes.has(step.id)) {
        const journalDeclaredChannel = step.produces
          ? typeof step.produces === 'string'
            ? step.produces
            : step.produces.channel
          : typeof step.params?.export_as === 'string'
            ? step.params.export_as
            : normalizePipelineOp(step.op) === 'core:judge_route'
              ? 'judge_route'
              : undefined;
        const snapshot: Record<string, unknown> = {};
        if (
          journalDeclaredChannel &&
          Object.prototype.hasOwnProperty.call(ctx, journalDeclaredChannel)
        ) {
          snapshot[journalDeclaredChannel] = ctx[journalDeclaredChannel];
        }
        const controlStateSnapshot: Record<string, unknown> = {};
        for (const key of ['__pipeline_route_next', '__judge_route_history', '__adf_terminal']) {
          if (Object.prototype.hasOwnProperty.call(ctx, key)) controlStateSnapshot[key] = ctx[key];
        }
        if (outcome.status === 'failed') {
          opts.runJournal.append('node_failed', {
            step_id: step.id,
            error: outcome.error || 'step failed',
            duration_ms: durationMs,
          });
        } else if (outcome.status === 'success' || outcome.status === 'recovered') {
          opts.runJournal.append('node_completed', {
            step_id: step.id,
            output_channels_snapshot: snapshot,
            ...(Object.keys(controlStateSnapshot).length > 0
              ? { control_state_snapshot: controlStateSnapshot }
              : {}),
            output_hash: hashPipelineOutput(snapshot),
            duration_ms: durationMs,
          });
        }
      }
      // OH-04 offloads oversized step output to an artifact and leaves a
      // `{artifact_path, preview}` reference behind. That is right for tool
      // logs, but a step's declared channel exists precisely so a later step
      // can consume it: replacing a large structured payload with a preview
      // hands the next op a truncated object, which fails far from the cause
      // (or worse, succeeds on partial data). Generic text output still
      // offloads; the declared channel never does.
      const declaredChannel = step.produces
        ? typeof step.produces === 'string'
          ? step.produces
          : step.produces.channel
        : undefined;
      const outputKeys = [
        ...(declaredChannel ? [] : [resolveExportKey(step, 'last_output')]),
        'last_output',
        'last_result',
        'stdout',
        'stderr',
        'output',
        'result',
        'response',
      ].filter((key) => key !== declaredChannel);
      let nextCtx = ctx;
      try {
        nextCtx = compactStepOutputContext(ctx, outputKeys, {
          maxInlineChars: Number((initialCtx.__pipeline_options as any)?.max_inline_output_chars),
          missionId: String(ctx.mission_id || process.env.MISSION_ID || 'shared'),
          stepOp: normalizedOp,
          stepNumber,
          recordArtifact: (artifactPath, description) => {
            opts.trace?.addArtifact('log', artifactPath, description);
          },
        });
      } catch (err) {
        logger.warn(`[OH-04] output offload skipped for ${normalizedOp}: ${String(err)}`);
      }
      opts.trace?.endSpan(
        outcome.status === 'failed' ? 'error' : 'ok',
        outcome.status === 'failed' ? (failureInfo?.summary ?? outcome.error) : undefined
      );
      stepRefStack.pop();
      return nextCtx;
    },
  };

  const pipelineOptions = (initialCtx as any).__pipeline_options as
    { max_steps?: unknown; timeout_ms?: unknown; max_concurrency?: unknown } | undefined;
  const explicitMaxSteps = Number(pipelineOptions?.max_steps);
  const explicitTimeoutMs = Number(pipelineOptions?.timeout_ms);
  // AR-01: options.max_steps / timeout_ms are enforced (canonical-engine
  // semantics) only when the pipeline sets them explicitly; long-running
  // pipelines without explicit budgets keep their unbounded behavior — the
  // engine's own defaults (1000 steps / 60s) would otherwise silently cap
  // every pipeline that doesn't opt in.
  const maxSteps =
    Number.isFinite(explicitMaxSteps) && explicitMaxSteps > 0
      ? explicitMaxSteps
      : Number.MAX_SAFE_INTEGER;
  const timeoutMs =
    Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0
      ? explicitTimeoutMs
      : Number.MAX_SAFE_INTEGER;

  const graphDeclared = steps.some(
    (step) =>
      Array.isArray((step as any).depends_on) ||
      (step as any).consumes !== undefined ||
      (step as any).when !== undefined
  );
  const graphExecutionEnabled =
    steps.length > 1 &&
    (graphDeclared ||
      (Number.isFinite(Number(pipelineOptions?.max_concurrency)) &&
        Number(pipelineOptions?.max_concurrency) > 1));
  const graphArtifact: GraphRunArtifact | undefined = graphExecutionEnabled
    ? createGraphRunArtifact(
        deriveExecutionGraph(prepareEngineSteps(steps), Object.keys(initialCtx)).graph,
        opts.runId,
        opts.trace?.traceId
      )
    : undefined;

  try {
    const engineResult = await executeAdfSteps(
      prepareEngineSteps(steps),
      initialCtx,
      {
        maxSteps,
        timeoutMs,
        maxConcurrency:
          Number.isFinite(Number(pipelineOptions?.max_concurrency)) &&
          Number(pipelineOptions?.max_concurrency) > 0
            ? Number(pipelineOptions?.max_concurrency)
            : 1,
        resumeCompletedNodeIds: new Set(opts.resumeState?.completed_nodes.keys()),
        onGraphNodeSettled: graphArtifact
          ? (node, outcome, durationMs) =>
              recordGraphRunNode(graphArtifact, node, outcome, durationMs)
          : undefined,
        resolveVars: (value: any, c: any) => resolveVars(value, c),
        // KC-04: pre_tool_use hooks can block a step; a block aborts the run.
        stepGate: async (step, _stepNumber) => {
          const outcome = await fireLifecycleHooks(
            getDefaultLifecycleHookEngine(),
            'pre_tool_use',
            { matcher_value: String(step.op), op: String(step.op) }
          );
          return outcome.blocked ? { blocked: true, reasons: outcome.reasons } : undefined;
        },
      },
      handlers,
      hooks
    );
    if (graphArtifact) {
      const artifactPath = persistGraphRunArtifact(graphArtifact);
      opts.trace?.addArtifact('log', artifactPath, 'Pipeline DAG run graph');
    }
    return { status: derivePipelineStatus(results), results, context: engineResult.context };
  } catch (err: any) {
    if (err?.adfControlFlow === 'suspend') throw err;
    // Only the engine's own pre-step safety-limit checks (max_steps /
    // timeout_ms) throw out of executeAdfSteps directly — every per-step
    // failure is already caught and returned as a 'failed' result entry by
    // the engine itself.
    logger.error(`  [SYS_PIPELINE] ${err.message}`);
    results.push({ op: 'pipeline:budget', status: 'failed', error: err.message });
    return { status: 'failed', results, context: lastKnownCtx };
  }
}

/** Validate Typed Flow channel integrity before allowing any step side effects. */
class TypedFlowValidationError extends Error {
  constructor(readonly flowErrors: ReturnType<typeof validateFlow>) {
    super(formatFlowValidationErrors(flowErrors));
    this.name = 'TypedFlowValidationError';
  }
}

export async function runValidatedSteps(
  steps: PipelineAdfStep[],
  initialCtx: Record<string, unknown> = {},
  opts: RunStepsOptions = {}
) {
  try {
    return (
      await runAdfLifecycle({
        draft: () => steps,
        preflight: (draft) => {
          const flowErrors = validateFlow(draft, initialCtx);
          if (flowErrors.length > 0) throw new TypedFlowValidationError(flowErrors);
          return draft;
        },
        // SX-11 / AGENTS.md: invalid pipeline contracts use the canonical
        // repair agent as the lifecycle's one auto-repair hook. The one-shot
        // guard prevents an unchanged repair from becoming a retry loop.
        autoRepair:
          opts.pipelinePath && !opts._adfRepairAttempted
            ? async (draft) => {
                const repair = await validateAndRepairAdf(opts.pipelinePath!, 'pipeline-adf');
                if (!repair.repaired) {
                  throw new TypedFlowValidationError(validateFlow(draft, initialCtx));
                }
                return (await readValidatedWorkflowAdf(opts.pipelinePath!)).steps;
              }
            : undefined,
        commit: (prepared) => prepared,
        execute: (committed) => runSteps(committed, initialCtx, opts),
      })
    ).result;
  } catch (error) {
    if (!(error instanceof TypedFlowValidationError)) throw error;

    const message = error.message;
    for (const flowError of error.flowErrors) {
      logger.warn(`[FLOW_VALIDATION] ${formatFlowValidationErrors([flowError])}.`);
    }
    opts.trace?.addEvent('pipeline.validation_failed', {
      validation_type: 'typed_flow',
      error: message,
      error_count: error.flowErrors.length,
    });
    return {
      status: 'failed' as const,
      results: [{ op: 'flow:validate', status: 'failed' as const, error: message }],
      context: { ...initialCtx },
    };
  }
}

export interface ExecutePipelineFileOptions {
  context?: Record<string, unknown>;
  trace?: TraceContext;
  quiet?: boolean;
  hasHuman?: boolean;
}

/**
 * Library entry for callers that already run inside the Kyberion process.
 *
 * The CLI remains responsible for durable resume journals and terminal exit
 * codes. This entry deliberately shares the same validated input, ADF
 * lifecycle, actuator dispatch, trace finalization, and feedback loop rather
 * than spawning a second `run_pipeline` process.
 */
export async function executePipelineFile(
  inputPath: string,
  options: ExecutePipelineFileOptions = {}
) {
  const pipeline = await readValidatedWorkflowAdf(inputPath);
  const pipelineId = String(
    pipeline.pipeline_id || pipeline.id || nodePath.basename(inputPath, nodePath.extname(inputPath))
  );
  const baseContext = (pipeline.context || {}) as Record<string, unknown>;
  const missionId =
    String(options.context?.mission_id || baseContext.mission_id || process.env.MISSION_ID || '') ||
    undefined;
  const autoContext: Record<string, unknown> = {
    repo_root: pathResolver.rootDir(),
    platform_name: process.platform,
    node_options: process.env.NODE_OPTIONS || '',
    run_utc_now: new Date().toISOString(),
    __pipeline_options: pipeline.options || {},
  };
  if (missionId) {
    const missionPath = findMissionPath(missionId);
    const evidenceDir = missionEvidenceDir(missionId);
    if (missionPath) {
      autoContext.mission_dir =
        nodePath.relative(pathResolver.rootDir(), missionPath) || missionPath;
      autoContext.mission_tier = nodePath.basename(nodePath.dirname(missionPath));
    }
    if (evidenceDir) {
      autoContext.mission_evidence_dir =
        nodePath.relative(pathResolver.rootDir(), evidenceDir) || evidenceDir;
    }
  }
  if (pipeline.knowledge_scope) autoContext._knowledge_scope = pipeline.knowledge_scope;
  const mergedContext = { ...baseContext, ...autoContext, ...(options.context || {}) };
  const trace =
    options.trace ||
    new TraceContext(`pipeline:${pipelineId}`, {
      ...(missionId ? { missionId } : {}),
      pipelineId,
    });
  trace.addArtifact('file', inputPath, 'Pipeline ADF input');
  const steps = (pipeline.steps || []).map((step) => ({ ...step, params: step.params || {} }));
  const run = () =>
    runValidatedSteps(steps, mergedContext, {
      trace,
      pipelinePath: inputPath,
      quiet: options.quiet,
      hasHuman: options.hasHuman,
    });
  const missionTier = String(autoContext.mission_tier || '');
  const payloadTier: 'public' | 'confidential' | 'personal' =
    missionTier === 'personal'
      ? 'personal'
      : missionTier === 'confidential'
        ? 'confidential'
        : 'public';
  const result =
    payloadTier === 'public'
      ? await run()
      : await withReasoningPayloadScope(
          {
            tier: payloadTier,
            tenant_slug: registeredEnv('KYBERION_CUSTOMER')?.trim() || undefined,
            purpose: `pipeline ${pipelineId}`,
          },
          run
        );
  const failed = result.results.some((entry) => entry.status === 'failed');
  const persisted = finalizePipelineTrace(trace, !failed);
  result.context.trace_summary = persisted.trace.rootSpan.status;
  result.context.trace_persisted_path =
    nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path;
  runFeedbackLoop(pipelineId, failed ? 'failed' : 'succeeded', persisted.trace);
  return { ...result, trace, persistedPath: persisted.path };
}

export async function main() {
  // Propagate resolved identity to process.env so spawned subprocesses inherit them.
  const identity = resolveIdentityContext();
  if (identity.role && !process.env.MISSION_ROLE) {
    process.env.MISSION_ROLE = identity.role;
  }
  if (identity.persona && !getRegisteredEnvText('KYBERION_PERSONA')) {
    setRegisteredEnv('KYBERION_PERSONA', identity.persona);
  }

  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: false })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Statically assess the pipeline without dispatching tools or providers',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      describe: 'Emit machine-readable JSON for dry-run output',
    })
    .option('resume', {
      type: 'string',
      describe: 'Resume a durable pipeline run by run id',
    })
    .option('context', {
      alias: 'c',
      type: 'string',
      describe: 'JSON string merged into pipeline.context (overrides)',
    })
    .option('quiet', {
      type: 'boolean',
      default: false,
      describe: 'Suppress step-by-step progress output',
    })
    .parseSync();

  let resumeState: PipelineRunJournalState | undefined;
  if (argv.resume) {
    resumeState = loadPipelineRunJournal(String(argv.resume), process.env.MISSION_ID);
    if (!argv.input) argv.input = resumeState.started?.input_path;
  }
  if (!argv.input) throw new Error('Either --input or --resume is required.');

  if (argv['dry-run']) {
    try {
      const pipeline = await readValidatedWorkflowAdf(argv.input as string);
      const report = assessPipelineDryRun(pipeline as Parameters<typeof assessPipelineDryRun>[0]);
      if (argv.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`[pipeline-dry-run] ${report.verdict}: ${report.pipeline_id}\n`);
        for (const check of report.checks) {
          process.stdout.write(`- ${check.status}: ${check.message}\n`);
        }
        for (const action of report.next_actions) process.stdout.write(`next: ${action}\n`);
      }
      process.exitCode = report.verdict === 'blocked' ? 1 : 0;
      return;
    } catch (error) {
      const report = {
        version: '1.0' as const,
        pipeline_id: String(argv.input),
        verdict: 'blocked' as const,
        side_effects: 'none' as const,
        checks: [
          {
            id: 'contract-validation',
            status: 'blocked' as const,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        next_actions: ['Fix the pipeline ADF/guardrail validation errors and rerun the dry-run.'],
      };
      if (argv.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stderr.write(`[pipeline-dry-run] blocked: ${report.checks[0].message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // Bootstrap reasoning + voice backends before any actuator dispatch.
  installReasoningBackends();
  installPythonVoiceBridgeIfAvailable();
  killSwitch.startMonitor(Number(registeredEnv('KYBERION_KILL_SWITCH_INTERVAL_MS') || 10000));

  // Safety guard: restore BlackHole mic routing on Ctrl+C or SIGTERM.
  // The pipeline's `||` fallback only fires on non-zero exit codes, not SIGINT.
  // Without this, a user pressing Ctrl+C during a meeting join pipeline would
  // leave their system microphone locked to BlackHole.
  const cleanupAndExit = (code: number) => {
    resetRouterSync();
    process.exit(code);
  };
  process.once('SIGINT', () => cleanupAndExit(130));
  process.once('SIGTERM', () => cleanupAndExit(143));

  const pipeline = await readValidatedWorkflowAdf(argv.input as string);

  const baseContext = (pipeline.context || {}) as Record<string, unknown>;
  let overrideContext: Record<string, unknown> = {};
  if (argv.context) {
    try {
      overrideContext = JSON.parse(argv.context as string);
    } catch (err: any) {
      logger.error(`❌ [PIPELINE] Invalid --context JSON: ${err.message}`);
      process.exit(1);
    }
  }
  const firstNonEmpty = (...candidates: (string | undefined)[]): string | undefined =>
    candidates.find((v): v is string => typeof v === 'string' && v.length > 0);
  const missionId = firstNonEmpty(
    overrideContext.mission_id as string | undefined,
    baseContext.mission_id as string | undefined,
    process.env.MISSION_ID
  );
  const autoContext: Record<string, unknown> = {};
  // Propagate missionId to env so tier-guard can resolve ${MISSION_ID} in default_allow paths.
  if (missionId && !process.env.MISSION_ID) {
    process.env.MISSION_ID = missionId;
  }
  if (missionId) {
    const missionPath = findMissionPath(missionId);
    const evidenceDir = missionEvidenceDir(missionId);
    if (missionPath) {
      autoContext.mission_dir =
        nodePath.relative(pathResolver.rootDir(), missionPath) || missionPath;
      autoContext.mission_tier = nodePath.basename(nodePath.dirname(missionPath));
    }
    if (evidenceDir) {
      autoContext.mission_evidence_dir =
        nodePath.relative(pathResolver.rootDir(), evidenceDir) || evidenceDir;
    }
  }
  autoContext.browser_session_id = `${pipeline.pipeline_id || path.basename(String(argv.input), path.extname(String(argv.input)))}`;
  autoContext.repo_root = pathResolver.rootDir();
  autoContext.platform_name = process.platform;
  autoContext.node_options = process.env.NODE_OPTIONS || '';
  autoContext.run_utc_now = new Date().toISOString();
  autoContext.__pipeline_options = pipeline.options || {};

  // Propagate pipeline knowledge_scope so wisdom:query uses the right tier/customer index.
  // Falls back to public-only scope when not declared.
  if (pipeline.knowledge_scope) {
    autoContext._knowledge_scope = pipeline.knowledge_scope;
  } else if (autoContext.mission_tier && autoContext.mission_tier !== 'public') {
    // Infer scope from mission tier when pipeline doesn't declare one explicitly
    const inferredScope: Record<string, unknown> = {
      tiers: ['public', autoContext.mission_tier],
    };
    const customer = registeredEnv('KYBERION_CUSTOMER')?.trim();
    if (customer) inferredScope.customerId = customer;
    autoContext._knowledge_scope = inferredScope;
  }
  const mergedContext = { ...baseContext, ...autoContext, ...overrideContext };
  // Restore only declared output channels from completed journal nodes. The
  // journal never carries the full mutable context.
  for (const node of resumeState?.completed_nodes.values() || []) {
    Object.assign(mergedContext, node.output_channels_snapshot);
    Object.assign(mergedContext, node.control_state_snapshot || {});
  }

  logger.info(
    `🚀 [PIPELINE] Running ${argv.input.match(/\.(ts|js|mjs|cjs)$/u) ? 'workflow module' : 'ADF pipeline'}: ${pipeline.name || argv.input}`
  );
  logger.info(`   [PIPELINE] Mission ID: ${missionId || 'NONE'}`);
  logger.info(`   [PIPELINE] Evidence Dir: ${autoContext.mission_evidence_dir || 'UNDEFINED'}`);

  const pipelineId = String(
    pipeline.pipeline_id ||
      pipeline.id ||
      path.basename(String(argv.input), path.extname(String(argv.input)))
  );
  const trace = new TraceContext(`pipeline:${pipelineId}`, {
    ...(missionId ? { missionId } : {}),
    pipelineId,
  });
  trace.addArtifact('file', String(argv.input), 'Pipeline ADF input');
  getDefaultWorkerEventStream().emit(
    'turn_begin',
    { kind: 'pipeline', pipeline_id: pipelineId, input: String(argv.input) },
    { pipeline_id: pipelineId, ...(missionId ? { mission_id: missionId } : {}) }
  );

  let runJournal: PipelineRunJournalHandle | undefined;
  let settledLifecycleHookEmitted = false;
  let agentStartAdmitted = false;
  try {
    const stepsToRun = (pipeline.steps || []).map((step) => ({
      ...step,
      params: step.params || {},
    }));
    const runId = resumeState?.run_id || newPipelineRunId();
    const activeRunJournal = resumeState
      ? openPipelineRunJournal(resumeState)
      : createPipelineRunJournal(
          runId,
          {
            pipeline_id: pipelineId,
            input_path: String(argv.input),
            ...(missionId ? { mission_id: missionId } : {}),
            step_ids: stepsToRun.map((step, index) => step.id || `__step_${index}`),
          },
          missionId
        );
    runJournal = activeRunJournal;
    if (resumeState) {
      activeRunJournal.append('run_resumed', { resumed_at: new Date().toISOString() });
    }
    const sessionStart = await fireLifecycleHooks(
      getDefaultLifecycleHookEngine(),
      'session_start',
      {
        matcher_value: pipelineId,
        pipeline_id: pipelineId,
      }
    );
    if (sessionStart.blocked) {
      throw new Error(
        `[SAFETY_LIMIT][HOOK_BLOCKED] session_start blocked: ${sessionStart.reasons.join('; ')}`
      );
    }
    // PI-08: expose the governed agent-entry boundary before any pipeline
    // step can reach a reasoning/model-backed operation. Only metadata is
    // exposed here; prompt content remains at its ledgered call boundary.
    const beforeAgentStart = await fireLifecycleHooks(
      getDefaultLifecycleHookEngine(),
      'before_agent_start',
      {
        matcher_value: pipelineId,
        pipeline_id: pipelineId,
        ...(missionId ? { mission_id: missionId } : {}),
        systemPromptOptions: {
          pipelineId,
          ...(missionId ? { missionId } : {}),
          promptVisibility: 'ledgered',
          resumed: Boolean(resumeState),
          stepCount: stepsToRun.length,
        },
      }
    );
    if (beforeAgentStart.blocked) {
      throw new Error(
        `[HOOK_BLOCKED] before_agent_start blocked pipeline ${pipelineId}: ${beforeAgentStart.reasons.join('; ')}`
      );
    }
    agentStartAdmitted = true;
    // SA-04: declare the payload tier once, at the mission boundary, so every
    // reasoning call made anywhere inside this run inherits it. Annotating each
    // call site individually would be missed the first time someone adds a new
    // one; the mission already knows its tier, so it is the honest place to say
    // it. A run with no mission stays unscoped (public work, previous behaviour).
    const missionTier = String(autoContext.mission_tier || '');
    const payloadTier: 'public' | 'confidential' | 'personal' =
      missionTier === 'personal'
        ? 'personal'
        : missionTier === 'confidential'
          ? 'confidential'
          : 'public';
    const runSteps = () =>
      runValidatedSteps(stepsToRun, mergedContext, {
        trace,
        pipelinePath: argv.input as string,
        quiet: argv.quiet as boolean,
        hasHuman: resolvePipelineHumanPresence(),
        runJournal: activeRunJournal,
        resumeState,
        runId,
      });
    const result =
      payloadTier === 'public'
        ? await runSteps()
        : await withReasoningPayloadScope(
            {
              tier: payloadTier,
              tenant_slug: registeredEnv('KYBERION_CUSTOMER')?.trim() || undefined,
              purpose: `pipeline ${pipelineId}`,
            },
            runSteps
          );
    const failed = result.results.find((entry) => entry.status === 'failed');
    const failure = failed ? formatPipelineFailure(failed.error || 'unknown error') : undefined;
    const recovered = failure ? tryPermissionFallback(pipeline, failure, trace) : false;
    const pipelineStatus = result.status === 'succeeded' || recovered ? 'succeeded' : 'failed';
    // PI-08: settled is deliberately after fallback/repair work. It is a
    // receipt point, not another execution gate, so a blocking hook is
    // recorded but cannot retroactively change the completed result.
    if (agentStartAdmitted && !settledLifecycleHookEmitted) {
      settledLifecycleHookEmitted = true;
      const settled = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'task_settled', {
        matcher_value: pipelineId,
        pipeline_id: pipelineId,
        status: pipelineStatus,
        recovered,
      });
      if (settled.blocked) {
        logger.warn(
          `[PI-08] task_settled observer blocked after result was finalized: ${settled.reasons.join('; ')}`
        );
      }
    }
    const sessionEnd = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'session_end', {
      matcher_value: pipelineId,
      pipeline_id: pipelineId,
      status: pipelineStatus,
    });
    if (sessionEnd.blocked) {
      throw new Error(
        `[SAFETY_LIMIT][HOOK_BLOCKED] session_end blocked: ${sessionEnd.reasons.join('; ')}`
      );
    }
    const persisted = finalizePipelineTrace(trace, recovered);
    result.context.trace_summary = persisted.trace.rootSpan.status;
    result.context.trace_persisted_path =
      nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path;
    logger.info(`   [PIPELINE] Trace: ${result.context.trace_persisted_path}`);
    activeRunJournal.append('run_finished', { status: pipelineStatus });
    getDefaultWorkerEventStream().emit(
      'turn_end',
      { kind: 'pipeline', pipeline_id: pipelineId, status: pipelineStatus, recovered },
      { pipeline_id: pipelineId, ...(missionId ? { mission_id: missionId } : {}) }
    );
    runFeedbackLoop(pipelineId, pipelineStatus, persisted.trace);
    // LC-09: surface semantic-decision degradations in the run summary —
    // a pipeline that "succeeded" on deterministic fallbacks every time is
    // otherwise indistinguishable from one whose LLM decisions worked.
    const semanticDegradations = getSemanticDecideDegradations();
    if (semanticDegradations.length > 0) {
      const byReason = semanticDegradations.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.reason] = (acc[entry.reason] || 0) + 1;
        return acc;
      }, {});
      appendSemanticDegradationRun(pipelineId, byReason);
      logger.warn(
        `   [PIPELINE] llm_decide degraded ${semanticDegradations.length}x (${Object.entries(
          byReason
        )
          .map(([reason, count]) => `${reason}=${count}`)
          .join(', ')}) — deterministic fallbacks were used.`
      );
    }
    if (result.status === 'succeeded' || recovered) {
      logger.success(`✅ [PIPELINE] Completed: ${pipeline.name || argv.input}`);
      // LC-02: success-first, promote-on-reuse. An ad-hoc ADF (outside the
      // pipelines/ catalog) that just succeeded is a promotion candidate —
      // one advisory line, never forced.
      const inputRelative = nodePath
        .relative(pathResolver.rootDir(), nodePath.resolve(String(argv.input)))
        .replace(/\\/g, '/');
      if (!inputRelative.startsWith('pipelines/') && !inputRelative.startsWith('..')) {
        const successCount = recordAdhocPipelineRun(inputRelative);
        if (successCount >= PROMOTION_CANDIDATE_MIN_RUNS) {
          logger.warn(
            `   [PIPELINE] This ad-hoc ADF has now succeeded ${successCount}x — promote it: pnpm pipeline:promote --input ${inputRelative}`
          );
        } else {
          logger.info(
            `   [PIPELINE] Reusable? Promote this run into the catalog: pnpm pipeline:promote --input ${inputRelative}`
          );
        }
      }
      if (autoContext.__pipeline_options && (autoContext.__pipeline_options as any).keep_alive) {
        logger.info(
          '   [PROCESS] Browser session kept alive per pipeline options. Terminal will remain open.'
        );
      } else {
        process.exit(0);
      }
    } else {
      if (failed) {
        logger.error(`❌ [PIPELINE] Failed step: ${failed.op} :: ${failure!.summary}`);
        logNextActionForPipelineFailure(failure!, String(argv.input));
      }
      logger.error(`❌ [PIPELINE] Failed: ${pipeline.name || argv.input}`);
      process.exit(1);
    }
  } catch (err: any) {
    if (err instanceof PipelineSuspendedError) {
      trace.addEvent('pipeline.suspended', {
        step_id: err.suspension.step_id,
        approval_request_id: err.suspension.approval_request_id,
        on_timeout: err.suspension.on_timeout,
        ...(err.suspension.timeout_at ? { timeout_at: err.suspension.timeout_at } : {}),
      });
      if (runJournal) runJournal.append('run_suspended', { ...err.suspension });
      getDefaultWorkerEventStream().emit(
        'turn_end',
        {
          kind: 'pipeline',
          pipeline_id: pipelineId,
          status: 'suspended',
          approval_request_id: err.suspension.approval_request_id,
        },
        { pipeline_id: pipelineId, ...(missionId ? { mission_id: missionId } : {}) }
      );
      const persisted = finalizeAndPersist(trace);
      logger.info(
        `   [PIPELINE] Suspended: ${nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
      );
      logger.warn(
        `⏸️ [PIPELINE] Awaiting decision ${err.suspension.approval_request_id}. Resume with --resume ${runJournal?.runId || 'the run id'}.`
      );
      process.exit(0);
    }
    const failure = formatPipelineFailure(err);
    const recovered = tryPermissionFallback(pipeline, failure, trace);
    if (agentStartAdmitted && !settledLifecycleHookEmitted) {
      settledLifecycleHookEmitted = true;
      const settled = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'task_settled', {
        matcher_value: pipelineId,
        pipeline_id: pipelineId,
        status: recovered ? 'succeeded' : 'failed',
        recovered,
        error: err?.message ?? String(err),
      });
      if (settled.blocked) {
        logger.warn(
          `[PI-08] task_settled observer blocked after failure was finalized: ${settled.reasons.join('; ')}`
        );
      }
    }
    getDefaultWorkerEventStream().emit(
      'turn_end',
      {
        kind: 'pipeline',
        pipeline_id: pipelineId,
        status: recovered ? 'succeeded' : 'failed',
        recovered,
        error: err?.message ?? String(err),
      },
      { pipeline_id: pipelineId, ...(missionId ? { mission_id: missionId } : {}) }
    );
    if (recovered) {
      const persisted = finalizePipelineTrace(trace, true);
      runFeedbackLoop(pipelineId, 'succeeded', persisted.trace);
      logger.info(
        `   [PIPELINE] Trace: ${nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
      );
      process.exit(0);
    }
    trace.addEvent('pipeline.error', {
      error: err?.message ?? String(err),
      error_category: failure.classification.category,
      error_rule_id: failure.classification.ruleId,
    });
    if (runJournal) {
      runJournal.append('run_finished', {
        status: recovered ? 'succeeded' : 'failed',
        error: err?.message ?? String(err),
      });
    }
    const persisted = finalizeAndPersist(trace);
    runFeedbackLoop(pipelineId, 'failed', persisted.trace);
    logger.info(
      `   [PIPELINE] Trace: ${nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
    );
    logger.error(`❌ [PIPELINE] Error: ${failure.summary}`);
    logNextActionForPipelineFailure(failure, String(argv.input));
    process.exit(1);
  }
}

const isDirectRun =
  isDirectScript(import.meta.url, 'run_pipeline.ts') ||
  isDirectScript(import.meta.url, 'run_pipeline.js');

if (isDirectRun) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
