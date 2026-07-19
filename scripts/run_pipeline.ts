import {
  attemptAutonomousRepair,
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
  runFeedbackLoop,
  determineActuatorStepType,
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
  resolveIdentityContext,
  executeAdfSteps,
  skipAdfStep,
  type AdfStep,
  type AdfStepHandlers,
  type AdfStepHooks,
  type AdfRunResult,
  type AdfSkippedStep,
  executeProgrammaticToolCall,
  getDefaultWorkerEventStream,
  getDefaultLifecycleHookEngine,
  fireLifecycleHooks,
  registerActuatorForwardingPort,
} from '@agent/core';
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
    process.env.KYBERION_PIPELINE_FALLBACK_ACTIVE
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
}

export interface ReasoningStepPolicy {
  effort?: 'low' | 'medium' | 'high';
  budget?: NormalizedStepBudget;
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
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeReasoningPolicy(step: PipelineAdfStep): ReasoningStepPolicy {
  return {
    effort:
      step.effort === 'low' || step.effort === 'medium' || step.effort === 'high'
        ? step.effort
        : undefined,
    budget: normalizeStepBudget(step.budget),
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
  return parts.length > 0 ? `\n\n[policy ${parts.join(' ')}]` : '';
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

async function loadActuatorDispatch(domain: string): Promise<DispatchFunc> {
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
        const prompt = `Instruction: ${resolvedInstruction || 'Analyze the context.'}\nContext: ${JSON.stringify(resolvedContext)}${buildReasoningPolicyNote(reasoningPolicy || {})}`;
        const reasoningCallOptions = {
          effort: reasoningPolicy?.effort,
          budget: reasoningPolicy?.budget,
        };
        const preCallBudgetError = isReasoningBudgetExceeded(reasoningPolicy || {}, prompt, '');
        if (preCallBudgetError) {
          throw new Error(
            `Reasoning budget exceeded${reasoningPolicy?.budget?.approval_required ? '; approval required' : ''}: ${preCallBudgetError}`
          );
        }
        const rawResponse = shouldUseSubagentForReasoningStep(params)
          ? await backend.delegateTask(
              String(resolvedInstruction || 'Analyze the context.'),
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
      process.env.KYBERION_PERSONA || 'unknown',
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
        let entry = capabilityEntry(`${domain}-actuator`);
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

      if (typeof mod.dispatchDecisionOp === 'function') {
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
  if (op === 'accumulate') return 'core:accumulate';
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
  'while',
  'loop_until',
  'retry_until_quality',
  'foreach',
  'parallel_foreach',
  'accumulate',
  'include',
]);

/** Engine routing only: does NOT replace resolveStepType's actuator-dispatch hint. */
function resolveEngineStepType(step: PipelineAdfStep): 'apply' | 'control' {
  const normalizedOp = normalizePipelineOp(step.op);
  const [domain, action] = normalizedOp.split(':');
  return domain === 'core' && CONTROL_ACTIONS.has(action) ? 'control' : 'apply';
}

function prepareEngineSteps(steps: PipelineAdfStep[]): AdfStep[] {
  return steps.map((step) => ({
    ...step,
    params: step.params || {},
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
  })) as unknown as AdfStep[];
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
  const prompt = `Instruction: ${resolvedInstruction || 'Analyze the context.'}\nContext: ${JSON.stringify(resolvedContext)}${buildReasoningPolicyNote(stepPolicy)}`;
  const reasoningCallOptions = { effort: stepPolicy.effort, budget: stepPolicy.budget };
  const preCallBudgetError = isReasoningBudgetExceeded(stepPolicy, prompt, '');
  if (preCallBudgetError) {
    throw new Error(
      `Reasoning budget exceeded${stepPolicy.budget?.approval_required ? '; approval required' : ''}: ${preCallBudgetError}`
    );
  }
  const rawResponse = shouldUseSubagentForReasoningStep(params)
    ? await backend.delegateTask(
        String(resolvedInstruction || 'Analyze the context.'),
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

/** All non-control ops (system:*, core:wait/run_janitor/transform/ptc, reasoning:*, actuator dispatch). */
async function dispatchLeafOp(
  step: PipelineAdfStep,
  ctx: Record<string, unknown>,
  rootDir: string,
  shellBin: string,
  opts: RunStepsOptions,
  stepPolicy: ReasoningStepPolicy
): Promise<Record<string, unknown>> {
  const normalizedOp = normalizePipelineOp(step.op);
  const [domain, action] = normalizedOp.split(':');
  const rawParams = (step.params || {}) as Record<string, unknown>;
  const _producedChannel = step.produces
    ? typeof step.produces === 'string'
      ? step.produces
      : step.produces.channel
    : undefined;
  const params =
    _producedChannel && !rawParams.export_as
      ? { ...rawParams, export_as: _producedChannel }
      : rawParams;

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
    return dispatchReasoningLeaf(params, ctx, stepPolicy);
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
  const effectiveType = resolveStepType(step);
  const dispatch = await loadActuatorDispatch(domain);
  const result = await dispatch(
    action,
    { ...params, _reasoning_policy: stepPolicy },
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
        const repaired = await attemptAutonomousRepair({
          step: { op: step.op, id: step.id, params: step.params },
          failure,
          pipelinePath: opts.pipelinePath!,
          policy: stepPolicy,
          validate: () => readValidatedWorkflowAdf(opts.pipelinePath!),
          logPrefix: '[SYS_PIPELINE:REPAIR]',
        });
        if (repaired) {
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
  const results: RunStepResult[] = [];
  const totalTopLevelSteps = steps.length;
  const stepStartTimes = new Map<number, number>();
  const stepRefStack: PipelineAdfStep[] = [];
  let includeStack: ReadonlySet<string> = opts._includeStack ?? new Set<string>();
  let lastKnownCtx: Record<string, unknown> = initialCtx;

  // Cross-actuator compatibility forwarding is registered at the orchestration
  // boundary. Wisdom only sees the port and never imports another actuator,
  // which keeps the dependency graph acyclic while allowing legacy wisdom
  // pipeline steps to execute at their canonical owner.
  registerActuatorForwardingPort({
    forward: async (request) => {
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
        status: 'succeeded',
        context: nextContext,
      };
    },
  });

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
      const items = resolveVars(params.items, ctx);
      const subSteps = params.do as PipelineAdfStep[];
      if (!Array.isArray(items) || !Array.isArray(subSteps)) return ctx;
      const itemName = (params.as as string) || 'item';
      const concurrency = coercePositiveInt(params.concurrency ?? params.parallelism, 2);
      const exportKey = resolveExportKey(
        { op: rawOp, params } as PipelineAdfStep,
        'last_parallel_foreach'
      );
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
      if (perItemContexts.length > 0) {
        workingCtx = { ...workingCtx, ...perItemContexts[perItemContexts.length - 1] };
      }
      return workingCtx;
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
          { ...ctx, ...inlineCtx },
          `core:include fragment failed: ${fragmentRef}`
        );
        return nested.context;
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
    afterStep: (rawStep, stepNumber, ctx, outcome) => {
      stepRefStack.pop();
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
      void fireLifecycleHooks(
        getDefaultLifecycleHookEngine(),
        outcome.status === 'failed' ? 'post_tool_use_failure' : 'post_tool_use',
        {
          matcher_value: normalizedOp,
          op: normalizedOp,
          status: outcome.status,
          ...(outcome.error ? { error: outcome.error } : {}),
        }
      ).catch((error) => {
        logger.error(
          `[LIFECYCLE_HOOK] post-tool hook telemetry failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
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
      const outputKeys = [
        resolveExportKey(step, 'last_output'),
        'last_output',
        'last_result',
        'stdout',
        'stderr',
        'output',
        'result',
        'response',
      ];
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
      return nextCtx;
    },
  };

  const pipelineOptions = (initialCtx as any).__pipeline_options as
    | { max_steps?: unknown; timeout_ms?: unknown }
    | undefined;
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

  try {
    const engineResult = await executeAdfSteps(
      prepareEngineSteps(steps),
      initialCtx,
      {
        maxSteps,
        timeoutMs,
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
    return { status: derivePipelineStatus(results), results, context: engineResult.context };
  } catch (err: any) {
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
export async function runValidatedSteps(
  steps: PipelineAdfStep[],
  initialCtx: Record<string, unknown> = {},
  opts: RunStepsOptions = {}
) {
  const flowErrors = validateFlow(steps, initialCtx);
  if (flowErrors.length === 0) return runSteps(steps, initialCtx, opts);

  const error = formatFlowValidationErrors(flowErrors);
  for (const flowError of flowErrors) {
    logger.warn(`[FLOW_VALIDATION] ${formatFlowValidationErrors([flowError])}.`);
  }
  opts.trace?.addEvent('pipeline.validation_failed', {
    validation_type: 'typed_flow',
    error,
    error_count: flowErrors.length,
  });
  return {
    status: 'failed' as const,
    results: [{ op: 'flow:validate', status: 'failed' as const, error }],
    context: { ...initialCtx },
  };
}

export async function main() {
  // Propagate resolved identity to process.env so spawned subprocesses inherit them.
  const identity = resolveIdentityContext();
  if (identity.role && !process.env.MISSION_ROLE) {
    process.env.MISSION_ROLE = identity.role;
  }
  if (identity.persona && !process.env.KYBERION_PERSONA) {
    process.env.KYBERION_PERSONA = identity.persona;
  }

  // Bootstrap reasoning + voice backends before any actuator dispatch.
  installReasoningBackends();
  installPythonVoiceBridgeIfAvailable();
  killSwitch.startMonitor(Number(process.env.KYBERION_KILL_SWITCH_INTERVAL_MS || 10000));

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

  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
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
    const customer = process.env.KYBERION_CUSTOMER?.trim();
    if (customer) inferredScope.customerId = customer;
    autoContext._knowledge_scope = inferredScope;
  }
  const mergedContext = { ...baseContext, ...autoContext, ...overrideContext };

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

  try {
    const stepsToRun = (pipeline.steps || []).map((step) => ({
      ...step,
      params: step.params || {},
    }));
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
    const result = await runValidatedSteps(stepsToRun, mergedContext, {
      trace,
      pipelinePath: argv.input as string,
      quiet: argv.quiet as boolean,
    });
    const sessionEnd = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'session_end', {
      matcher_value: pipelineId,
      pipeline_id: pipelineId,
      status: result.status,
    });
    if (sessionEnd.blocked) {
      throw new Error(
        `[SAFETY_LIMIT][HOOK_BLOCKED] session_end blocked: ${sessionEnd.reasons.join('; ')}`
      );
    }
    const failed = result.results.find((entry) => entry.status === 'failed');
    const failure = failed ? formatPipelineFailure(failed.error || 'unknown error') : undefined;
    const recovered = failure ? tryPermissionFallback(pipeline, failure, trace) : false;
    const persisted = finalizePipelineTrace(trace, recovered);
    result.context.trace_summary = persisted.trace.rootSpan.status;
    result.context.trace_persisted_path =
      nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path;
    logger.info(`   [PIPELINE] Trace: ${result.context.trace_persisted_path}`);
    const pipelineStatus = result.status === 'succeeded' || recovered ? 'succeeded' : 'failed';
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
    const failure = formatPipelineFailure(err);
    const recovered = tryPermissionFallback(pipeline, failure, trace);
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
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
