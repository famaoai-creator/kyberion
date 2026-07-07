import {
  TraceContext,
  finalizeAndPersist,
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
  safeExecResult,
  buildNextActionFromError,
  formatNextAction,
  runJanitor,
  checkActuatorCapabilities,
  killSwitch,
  validateOpInput,
  resolveIdentityContext,
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
  return step.type ?? 'apply';
}

/** Resolve the export key from produces / params.export_as. produces takes precedence. */
function resolveExportKey(step: PipelineAdfStep, defaultKey: string): string {
  if (step.produces) {
    return typeof step.produces === 'string' ? step.produces : step.produces.channel;
  }
  return String(step.params?.export_as ?? defaultKey);
}

type RunStepResult = { op: string; status: 'success' | 'failed' | 'skipped'; error?: string };

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
  _retryCount?: number;
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
      } catch {}
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
          const actionResult = await mod.handleAction({
            action: 'pipeline',
            steps: [{ type: type || 'apply', op, params }],
            context: ctx,
            options: ctx.__pipeline_options,
            ...(trace ? { pipelineTrace: trace } : {}),
          });
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
            !err.message.toLowerCase().includes('unsupported') &&
            !err.message.toLowerCase().includes('not a function')
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

export async function runSteps(
  steps: PipelineAdfStep[],
  initialCtx: Record<string, unknown> = {},
  opts: RunStepsOptions = {}
) {
  let ctx: Record<string, unknown> = { ...initialCtx };
  const results: RunStepResult[] = [];
  const shellBin = 'bash';
  const rootDir = pathResolver.rootDir();
  for (const step of steps) {
    const stepStartedAtMs = Date.now();
    const stepPolicy = normalizeReasoningPolicy(step);
    const stepTraceBase = {
      step_index: results.length,
      step_id: step.id || step.op,
      op: step.op,
      ...(step.role ? { step_role: step.role } : step.type ? { step_type: step.type } : {}),
      ...summarizeReasoningPolicy(stepPolicy),
    };
    // Normalize: role → effective type for downstream dispatch
    const effectiveType = resolveStepType(step);
    opts.trace?.startSpan(step.op, {
      ...stepTraceBase,
    });
    opts.trace?.addEvent('step.started', stepTraceBase);

    if (!opts.quiet) {
      logger.info(`[step ${results.length + 1}/${steps.length}] ${step.op} …`);
    }

    let attempt = 0;
    let stepSucceeded = false;
    let stepSkipped = false;
    let lastError: any = null;
    let currentNormalizedOp = step.op;
    const finishStepTrace = (
      eventName: string,
      status: 'success' | 'failed' | 'skipped',
      attributes: Record<string, string | number | boolean> = {}
    ): void => {
      opts.trace?.addEvent(eventName, {
        ...stepTraceBase,
        op: currentNormalizedOp,
        status,
        duration_ms: Date.now() - stepStartedAtMs,
        ...attributes,
      });

      if (!opts.quiet && (status === 'success' || status === 'failed')) {
        logger.info(
          `[step ${results.length + 1}/${steps.length}] ${currentNormalizedOp} ${status} in ${Math.round((Date.now() - stepStartedAtMs) / 1000)}s`
        );
      }
    };

    // ── before hooks ──────────────────────────────────────────────
    if (step.hooks?.before?.length) {
      const beforeDecision = await runStepHooks(
        step.hooks.before,
        ctx,
        'before',
        loadActuatorDispatch
      );
      if (beforeDecision === 'abort') {
        results.push({ op: step.op, status: 'failed', error: 'aborted by before hook' });
        finishStepTrace('step.aborted', 'failed');
        opts.trace?.endSpan('error', 'before hook abort');
        return { status: 'failed', results, context: ctx };
      }
      if (beforeDecision === 'skip') {
        results.push({ op: currentNormalizedOp, status: 'skipped' });
        finishStepTrace('step.skipped', 'skipped');
        opts.trace?.endSpan('ok');
        continue;
      }
    }

    while (attempt < 2 && !stepSucceeded) {
      // CRITICAL: Resolve normalizedOp, domain, action, and params INSIDE the attempt loop
      // so that repaired step definitions are actually used during the retry.
      const normalizedOp = normalizePipelineOp(step.op);
      currentNormalizedOp = normalizedOp;
      const [domain, action] = normalizedOp.split(':');
      // Bridge produces.channel → params.export_as so actuators (which read params.export_as)
      // write to the correct ctx key when a step uses the v2 Typed Flow format.
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
      try {
        if (domain === 'system' && action === 'log') {
          logger.info(resolveLogMessage(params, ctx));
        } else if (domain === 'system' && action === 'exec') {
          const resolvedParams = resolveParamsRecursive(params, ctx) as Record<string, unknown>;
          const command = String(resolvedParams.command ?? resolvedParams.cmd ?? '');
          if (!command) {
            throw new Error('system:exec requires "command" param');
          }
          const args = Array.isArray(resolvedParams.args)
            ? resolvedParams.args.map((value) => String(value))
            : [];
          const env = Object.fromEntries(
            Object.entries((resolvedParams.env || {}) as Record<string, unknown>).map(
              ([key, value]) => [key, typeof value === 'string' ? String(value) : String(value)]
            )
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
          const allowError =
            resolvedParams.allow_error === true || resolvedParams.allowError === true;
          if (!allowError && execResult.status !== 0) {
            throw new Error(
              execResult.stderr.trim() ||
                execResult.stdout.trim() ||
                `system:exec exited with status ${execResult.status}`
            );
          }
        } else if (domain === 'system' && action === 'write_file') {
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
        } else if (domain === 'system' && action === 'shell') {
          const cmd = String(resolveVars(params.cmd || '', ctx));
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
        } else if (domain === 'core' && action === 'if') {
          const cond = params.condition;
          const conditionResult = evaluateCondition(cond, ctx);
          const branch = conditionResult ? params.then : params.else;
          if (Array.isArray(branch)) {
            const nested = await runSteps(branch as PipelineAdfStep[], ctx, opts);
            ctx = nested.context;
            results.push(...nested.results);
          } else if (!conditionResult) {
            stepSkipped = true;
            results.push({ op: currentNormalizedOp, status: 'skipped' });
            finishStepTrace('step.skipped', 'skipped', {
              reason: 'core:if condition evaluated to false and no else branch was provided',
            });
            opts.trace?.endSpan('ok');
            stepSucceeded = true;
            continue;
          }
        } else if (
          domain === 'core' &&
          (action === 'while' || action === 'loop_until' || action === 'retry_until_quality')
        ) {
          const body = Array.isArray(params.pipeline)
            ? (params.pipeline as PipelineAdfStep[])
            : undefined;
          if (!body) {
            throw new Error(`${step.op} requires "pipeline" param`);
          }
          const maxIterations = coercePositiveInt(params.max_iterations ?? params.maxIterations, 1);
          const condition = params.condition ?? params.until ?? params.quality_condition;
          const exportKey = resolveExportKey(step, 'last_loop_result');
          const iterations: Array<{
            iteration: number;
            context: Record<string, unknown>;
            results: typeof results;
          }> = [];
          let loopCount = 0;
          while (loopCount < maxIterations) {
            if (condition !== undefined && action !== 'retry_until_quality') {
              const shouldContinue = Boolean(evaluateCondition(condition, ctx));
              if (!shouldContinue) break;
            }
            const nested = await runSteps(body, ctx, opts);
            ctx = nested.context;
            results.push(...nested.results);
            iterations.push({
              iteration: loopCount + 1,
              context: nested.context,
              results: nested.results,
            });
            loopCount += 1;
            if (action === 'retry_until_quality') {
              const verdict = String(
                (ctx as Record<string, unknown>).verdict ||
                  (ctx as Record<string, unknown>).quality ||
                  ''
              );
              if (verdict === 'ok' || verdict === 'pass' || verdict === 'passed') {
                break;
              }
            }
            if (condition !== undefined && action === 'retry_until_quality') {
              const shouldContinue = Boolean(evaluateCondition(condition, ctx));
              if (!shouldContinue) break;
            }
          }
          if (loopCount === 0) {
            stepSkipped = true;
            results.push({ op: currentNormalizedOp, status: 'skipped' });
            finishStepTrace('step.skipped', 'skipped', {
              reason: 'core:while condition evaluated to false before execution',
            });
            opts.trace?.endSpan('ok');
            stepSucceeded = true;
            continue;
          }
          ctx = {
            ...ctx,
            [exportKey]: {
              iterations: loopCount,
              history: iterations,
              final_context: ctx,
            },
          };
        } else if (domain === 'core' && action === 'foreach') {
          const items = resolveVars(params.items, ctx);
          const subSteps = params.do as PipelineAdfStep[];
          if (Array.isArray(items) && Array.isArray(subSteps)) {
            const itemName = (params.as as string) || 'item';
            const originalItemValue = ctx[itemName];
            for (const item of items) {
              const loopCtx = { ...ctx, [itemName]: item };
              const nested = await runSteps(subSteps, loopCtx, opts);
              ctx = { ...nested.context };
              if (originalItemValue === undefined) delete ctx[itemName];
              else ctx[itemName] = originalItemValue;
              results.push(...nested.results);
              if (nested.status === 'failed') break;
            }
          }
        } else if (domain === 'core' && action === 'parallel_foreach') {
          const items = resolveVars(params.items, ctx);
          const subSteps = params.do as PipelineAdfStep[];
          if (Array.isArray(items) && Array.isArray(subSteps)) {
            const itemName = (params.as as string) || 'item';
            const concurrency = coercePositiveInt(params.concurrency ?? params.parallelism, 2);
            const exportKey = resolveExportKey(step, 'last_parallel_foreach');
            const originalItemValue = ctx[itemName];
            const originalSharedCtx = { ...ctx };
            const perItemContexts: Array<Record<string, unknown>> = [];
            const perItemResults: Array<RunStepResult[]> = [];
            const perItemOutputs: Array<{
              index: number;
              item: unknown;
              context: Record<string, unknown>;
              results: RunStepResult[];
            }> = [];

            await runParallelBatches(items, concurrency, async (item, index) => {
              const loopCtx = { ...originalSharedCtx, [itemName]: item };
              const nested = await runSteps(subSteps, loopCtx, opts);
              if (nested.status === 'failed') {
                throw new Error(
                  `parallel_foreach item ${index + 1} failed: ${nested.results.find((r) => r.status === 'failed')?.error || 'nested failure'}`
                );
              }
              perItemContexts[index] = nested.context;
              perItemResults[index] = nested.results;
              perItemOutputs[index] = {
                index,
                item,
                context: nested.context,
                results: nested.results,
              };
            });

            ctx = {
              ...ctx,
              [exportKey]: perItemOutputs,
            };
            if (originalItemValue === undefined) delete ctx[itemName];
            else ctx[itemName] = originalItemValue;
            results.push(...perItemResults.flat());
            if (perItemContexts.length > 0) {
              ctx = { ...ctx, ...perItemContexts[perItemContexts.length - 1] };
            }
          }
        } else if (domain === 'core' && action === 'accumulate') {
          const items = resolveVars(params.items, ctx);
          const subSteps = params.do as PipelineAdfStep[];
          if (!Array.isArray(items)) {
            throw new Error('core:accumulate requires "items" to be an array');
          }
          if (!Array.isArray(subSteps)) {
            throw new Error('core:accumulate requires "do" pipeline steps');
          }
          const itemName = (params.as as string) || 'item';
          const collectKey = String(params.collect_as || params.export_as || 'result');
          const exportKey = resolveExportKey(step, 'last_accumulate');
          const originalItemValue = ctx[itemName];
          const originalSharedCtx = { ...ctx };
          const targetCount = coercePositiveInt(
            params.target_count ?? params.targetCount,
            items.length
          );
          const maxIterations = coercePositiveInt(
            params.max_iterations ?? params.maxIterations,
            items.length
          );
          const dryStreakLimit = coercePositiveInt(
            params.dry_streak_limit ?? params.dryStreakLimit,
            2
          );
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
            const nested = await runSteps(subSteps, loopCtx, opts);
            if (nested.status === 'failed') {
              throw new Error(
                `accumulate item ${index + 1} failed: ${nested.results.find((r) => r.status === 'failed')?.error || 'nested failure'}`
              );
            }

            const candidateValue =
              (nested.context as Record<string, unknown>)[collectKey] ?? nested.context ?? item;
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
                results: nested.results,
              });
              dryStreak = 0;
            } else {
              dryStreak += 1;
            }

            results.push(...nested.results);
            if (dryStreak >= dryStreakLimit) break;
          }

          ctx = {
            ...ctx,
            [exportKey]: {
              collected,
              iterations: loopCount,
              dry_streak: dryStreak,
              target_count: targetCount,
              final_context: ctx,
            },
          };
          if (originalItemValue === undefined) delete ctx[itemName];
          else ctx[itemName] = originalItemValue;
        } else if (domain === 'core' && action === 'include') {
          const fragmentRef = String(resolveVars(params.fragment || '', ctx));
          if (!fragmentRef) throw new Error('core:include requires "fragment" param');
          const fragmentPath = resolveFragmentPath(fragmentRef);
          if (!safeExistsSync(fragmentPath)) {
            throw new Error(
              `core:include: fragment not found: ${fragmentRef} (resolved: ${fragmentPath})`
            );
          }
          const includeStack = opts._includeStack ?? new Set<string>();
          if (includeStack.has(fragmentPath)) {
            throw new Error(
              `core:include: circular reference detected — ${fragmentRef} is already in the include chain`
            );
          }
          const fragmentRaw = String(safeReadFile(fragmentPath, { encoding: 'utf8' }));
          const fragmentJson = (() => {
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
          })();
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
          const childOpts: RunStepsOptions = {
            ...opts,
            _includeStack: new Set([...includeStack, fragmentPath]),
          };
          const nested = await runSteps(fragmentSteps, { ...ctx, ...inlineCtx }, childOpts);
          ctx = nested.context;
          results.push(...nested.results);
          if (nested.status === 'failed') {
            return { status: 'failed', results, context: ctx };
          }
        } else if (domain === 'core' && action === 'wait') {
          const ms = Number(resolveVars(params.duration_ms || params.ms || 1000, ctx));
          await new Promise((resolve) => setTimeout(resolve, ms));
        } else if (domain === 'core' && (action === 'run_janitor' || action === 'run-janitor')) {
          const dryRunParam = resolveVars(params.dry_run ?? params.dryRun ?? true, ctx);
          const dryRun = dryRunParam === true || dryRunParam === 'true';
          const report = runJanitor({ dryRun });
          const exportKey = resolveExportKey(step, 'janitor_report');
          ctx = { ...ctx, [exportKey]: report };
        } else if (domain === 'core' && action === 'transform') {
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
        } else if (
          domain === 'reasoning' &&
          (action === 'analyze' || action === 'transform' || action === 'synthesize')
        ) {
          const { getReasoningBackend } = await import('@agent/core');
          const backend = getReasoningBackend();
          const resolvedInstruction =
            typeof params.instruction === 'string'
              ? resolveVars(params.instruction, ctx)
              : params.instruction;
          const resolvedContext = Array.isArray(params.context)
            ? params.context.map((item) =>
                typeof item === 'string' ? resolveVars(item, ctx) : item
              )
            : typeof params.context === 'string'
              ? resolveVars(params.context, ctx)
              : params.context || ctx;
          const prompt = `Instruction: ${resolvedInstruction || 'Analyze the context.'}\nContext: ${JSON.stringify(resolvedContext)}${buildReasoningPolicyNote(stepPolicy)}`;
          const reasoningCallOptions = {
            effort: stepPolicy.effort,
            budget: stepPolicy.budget,
          };
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
            typeof params.export_as === 'string' && params.export_as
              ? params.export_as
              : 'last_reasoning';
          ctx = { ...ctx, [reasoningExportKey]: rawResponse };
        } else {
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
            ctx = result.ctx.context as Record<string, unknown>;
          } else {
            ctx = result.ctx;
          }
        }
        stepSucceeded = true;
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
          const repaired = await attemptAutonomousRepair(
            step,
            failure,
            ctx,
            opts.pipelinePath!,
            stepPolicy
          );
          if (repaired) {
            if (!opts.quiet) {
              logger.success(
                `  [SYS_PIPELINE] Repair successful. Refreshing ADF and retrying step ${step.op}...`
              );
            }

            try {
              // Reload fully from disk to get the REPAIRED definition
              const refreshedPipeline = await readValidatedWorkflowAdf(opts.pipelinePath!);
              const refreshedStep = refreshedPipeline.steps?.find(
                (s: any) => s.id === step.id || s.op === step.op
              );

              if (refreshedStep) {
                // Update the step object in place for the NEXT iteration of the while loop
                step.op = refreshedStep.op;
                step.params = refreshedStep.params;

                logger.info(
                  `  [SYS_PIPELINE] Step definition refreshed for ${step.id || step.op}. New path: ${step.params.path}`
                );

                attempt++;
                continue; // This will re-evaluate normalizedOp/domain/action/params with NEW values
              }
            } catch (reloadErr: any) {
              logger.warn(
                `  [SYS_PIPELINE] Failed to reload ADF after repair: ${reloadErr.message}.`
              );
            }
          }
        }
        break; // Max attempts or repair failed/not possible
      }
    }

    if (stepSucceeded) {
      if (stepSkipped) {
        continue;
      }
      // ── after hooks ─────────────────────────────────────────────
      if (step.hooks?.after?.length) {
        const afterDecision = await runStepHooks(
          step.hooks.after,
          ctx,
          'after',
          loadActuatorDispatch
        );
        if (afterDecision === 'abort') {
          results.push({
            op: currentNormalizedOp,
            status: 'failed',
            error: 'aborted by after hook',
          });
          finishStepTrace('step.aborted', 'failed');
          opts.trace?.endSpan('error', 'after hook abort');
          return { status: 'failed', results, context: ctx };
        }
      }
      results.push({ op: currentNormalizedOp, status: 'success' });
      finishStepTrace('step.completed', 'success');
      opts.trace?.endSpan('ok');
    } else {
      const message = lastError?.message ?? String(lastError);
      const failureFormatted = formatPipelineFailure(lastError);
      results.push({ op: currentNormalizedOp, status: 'failed', error: message });
      finishStepTrace('step.failed', 'failed', {
        error: message,
        error_category: failureFormatted.classification.category,
        error_rule_id: failureFormatted.classification.ruleId,
      });
      opts.trace?.endSpan('error', failureFormatted.summary);
      return { status: 'failed', results, context: ctx };
    }
  }

  return { status: derivePipelineStatus(results), results, context: ctx };
}

async function attemptAutonomousRepair(
  step: PipelineAdfStep,
  failure: any,
  ctx: any,
  pipelinePath: string,
  policy?: ReasoningStepPolicy
): Promise<boolean> {
  try {
    const { getReasoningBackend, sendOpsAlert } = await import('@agent/core');
    const backend = getReasoningBackend();

    const repairHint =
      failure.repairAction ||
      'Investigate the error and the pipeline ADF structure to identify a potential fix.';

    // AO-03 Task 4: classify the repair scope.
    // Safe repairs (ADF structure, parameters) may proceed autonomously.
    // Sensitive repairs (.env / authority / config / secrets) MUST NOT be attempted without
    // operator approval. In unattended runs there is no approval channel, so we fail-closed.
    const SENSITIVE_CATEGORIES = ['permission_error', 'auth_error', 'config_error', 'env_error'];
    const requiresApproval = SENSITIVE_CATEGORIES.includes(failure.category);

    if (requiresApproval) {
      logger.warn(
        `  [SYS_PIPELINE:REPAIR] Repair category "${failure.category}" involves .env/auth/config changes ` +
          `— autonomous mutation of sensitive paths is prohibited (AO-03 §4). Escalating to operator.`
      );
      // Escalate via ops-alert so the operator is notified even in unattended runs.
      if (typeof sendOpsAlert === 'function') {
        sendOpsAlert({
          severity: 'critical',
          title: `Pipeline repair blocked: ${step.op}`,
          context: {
            step_op: step.op,
            error_category: failure.category,
            error_detail: failure.detail,
            pipeline_path: pipelinePath,
          },
          recommendation:
            'Manual operator intervention required. Review the error, update .env / authority roles as appropriate, then re-run the pipeline.',
          dedupe_key: `pipeline-repair-blocked:${step.op}:${failure.category}`,
        });
      }
      return false;
    }

    const instruction = `
The following pipeline step failed in Kyberion:
Step Operation: ${step.op}
Step Params: ${JSON.stringify(step.params)}
Error Category: ${failure.category}
Error Detail: ${failure.detail}

Repair Hint: ${repairHint}
${policy ? `Step Policy: ${JSON.stringify(policy)}` : ''}

Repair Action Goal:
1. ANALYZE the error and parameters.
2. FIX the pipeline ADF structure at ${pipelinePath} if it is a structural or parameter error.
3. DO NOT modify .env files, authority roles, config secrets, or any file outside the pipeline ADF.
   If the error requires such changes, output a description of what needs to be changed but do NOT apply it.
4. Ensure the resulting ADF follows the required schema.

Assume the persona of a "Sovereign System Recovery Agent".
Once finished, provide a brief summary of the changes you applied to fix the pipeline.
`.trim();

    const report = await backend.delegateTask(
      instruction,
      `Self-Healing Mission for ${step.op}`,
      policy ? { effort: policy.effort, budget: policy.budget } : undefined
    );
    logger.info(`  [SYS_PIPELINE:REPAIR] Sub-agent report: ${report}`);

    // Confirm the ADF is actually valid after the repair attempt before signalling success.
    try {
      await readValidatedWorkflowAdf(pipelinePath);
    } catch (validationErr: any) {
      logger.warn(
        `  [SYS_PIPELINE:REPAIR] Sub-agent finished but ADF is still invalid: ${validationErr.message}`
      );
      return false;
    }
    return true;
  } catch (err: any) {
    logger.error(`  [SYS_PIPELINE:REPAIR] Failed to perform repair: ${err.message}`);
    return false;
  }
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

  try {
    const stepsToRun = (pipeline.steps || []).map((step) => ({
      ...step,
      params: step.params || {},
    }));
    // Typed Flow: validate channel integrity before execution
    const flowErrors = validateFlow(stepsToRun, mergedContext);
    if (flowErrors.length > 0) {
      for (const e of flowErrors) {
        logger.warn(
          `[FLOW_VALIDATION] Step "${e.stepId}" consumes unknown channel(s): ${e.missing.join(', ')} — ensure a preceding step produces them.`
        );
      }
    }
    const result = await runSteps(stepsToRun, mergedContext, {
      trace,
      pipelinePath: argv.input as string,
      quiet: argv.quiet as boolean,
    });
    const persisted = finalizeAndPersist(trace);
    result.context.trace_summary = persisted.trace.rootSpan.status;
    result.context.trace_persisted_path =
      nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path;
    logger.info(`   [PIPELINE] Trace: ${result.context.trace_persisted_path}`);
    const pipelineStatus = result.status === 'succeeded' ? 'succeeded' : 'failed';
    runFeedbackLoop(pipelineId, pipelineStatus, persisted.trace);
    if (result.status === 'succeeded') {
      logger.success(`✅ [PIPELINE] Completed: ${pipeline.name || argv.input}`);
      if (autoContext.__pipeline_options && (autoContext.__pipeline_options as any).keep_alive) {
        logger.info(
          '   [PROCESS] Browser session kept alive per pipeline options. Terminal will remain open.'
        );
      } else {
        process.exit(0);
      }
    } else {
      const failed = result.results.find((entry) => entry.status === 'failed');
      if (failed) {
        const failure = formatPipelineFailure(failed.error || 'unknown error');
        const fallbackPath = String((pipeline as any).fallback_pipeline || '');
        if (
          fallbackPath &&
          failure.classification.category === 'permission_denied' &&
          !process.env.KYBERION_PIPELINE_FALLBACK_ACTIVE
        ) {
          logger.warn(
            `⚠️ [PIPELINE] Primary first-win failed with permission denial. Running fallback pipeline: ${fallbackPath}`
          );
          const fallbackResult = runTsFallbackPipeline(fallbackPath);
          if (fallbackResult.status === 0) {
            logger.success(`✅ [PIPELINE] Fallback succeeded: ${fallbackPath}`);
            process.exit(0);
          }
          logger.error(`❌ [PIPELINE] Fallback failed: ${fallbackPath}`);
          if (fallbackResult.stdout.trim()) logger.error(fallbackResult.stdout.trim());
          if (fallbackResult.stderr.trim()) logger.error(fallbackResult.stderr.trim());
        }
        logger.error(`❌ [PIPELINE] Failed step: ${failed.op} :: ${failure.summary}`);
        logNextActionForPipelineFailure(failure, String(argv.input));
      }
      logger.error(`❌ [PIPELINE] Failed: ${pipeline.name || argv.input}`);
      process.exit(1);
    }
  } catch (err: any) {
    const failure = formatPipelineFailure(err);
    const fallbackPath = String((pipeline as any).fallback_pipeline || '');
    if (
      fallbackPath &&
      failure.classification.category === 'permission_denied' &&
      !process.env.KYBERION_PIPELINE_FALLBACK_ACTIVE
    ) {
      logger.warn(
        `⚠️ [PIPELINE] Primary first-win failed with permission denial. Running fallback pipeline: ${fallbackPath}`
      );
      const fallbackResult = runTsFallbackPipeline(fallbackPath);
      if (fallbackResult.status === 0) {
        logger.success(`✅ [PIPELINE] Fallback succeeded: ${fallbackPath}`);
        process.exit(0);
      }
      logger.error(`❌ [PIPELINE] Fallback failed: ${fallbackPath}`);
      if (fallbackResult.stdout.trim()) logger.error(fallbackResult.stdout.trim());
      if (fallbackResult.stderr.trim()) logger.error(fallbackResult.stderr.trim());
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
