import * as nodePath from 'node:path';
import { logger } from '@agent/core/core';
import { safeExistsSync, type SafeShell } from '@agent/core/secure-io';
import { retry } from '@agent/core/async-utils';
import { resolveVars } from '@agent/core/logic-utils';
import { capabilityEntry } from '@agent/core/path-resolver';
import { buildWorkingPrinciplesLines } from '@agent/core/working-principles';
import {
  isScenarioApprovalGranted,
  resolveActuatorOperation,
  resolveActuatorOperationTimeout,
  resolveScenarioOpOverride,
  type ResolvedActuatorOperation,
} from '@agent/core/actuator/actuator-op-registry';
import type { AdfStep, AdfSkippedStep } from '@agent/core/pipeline/adf-engine';
import { runOpPreflight } from '@agent/core/pipeline/op-preflight';
import { ensureDefaultOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
import { tryRepairJson } from '@agent/core/json-repair';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { type PipelineAdfStep } from '@agent/core/pipeline/pipeline-contract';
import { buildPipelinePromptVisibilityContext } from './pipeline-reasoning-visibility.js';
import {
  resolveStepType,
  resolveExportKey,
  buildReasoningPolicyNote,
  resolvePipelineReasoningOptions,
  resolvePipelineFacetNote,
  isReasoningBudgetExceeded,
  resolveParamsRecursive,
  loadActuatorDispatch,
  normalizePipelineOp,
  validatePipelineOpInput,
  resolveLogMessage,
  assertPipelineStepCapabilityAvailable,
  shouldUseSubagentForReasoningStep,
  runInlineSystemExec,
  runInlineSystemWriteFile,
  runInlineSystemShell,
  runInlineCoreWait,
  runInlineCoreJanitor,
  runInlineCoreMissionHygiene,
  runInlineCoreTransform,
  CONTROL_ACTIONS,
} from './pipeline-execution-part-bootstrap.js';
import type { ReasoningStepPolicy, RunStepsOptions } from './pipeline-execution-part-bootstrap.js';

/**
 * Private context key carrying the ancestry of resolved absolute pipeline
 * paths currently on the `core:run_pipeline` stack.
 *
 * A nested pipeline runs in-process through the injected library runner, so
 * without an ancestry a self-including pipeline (A -> A) or a cycle
 * (A -> B -> A) would recurse until the JS stack is exhausted.  The key is
 * engine-internal: it is stripped from the user-level child context and then
 * re-attached explicitly by `buildNestedPipelineContext`.
 */
export const PIPELINE_ANCESTRY_CONTEXT_KEY = '__pipeline_ancestry';

/**
 * Maximum number of pipelines allowed on the nesting stack, the outermost
 * pipeline included.  A constant rather than an environment knob: no
 * registered env var governs pipeline nesting, and adding one would widen the
 * env registry surface for a guardrail that should not be relaxed per run.
 */
export const MAX_PIPELINE_NESTING_DEPTH = 8;

/**
 * Context keys the engine derives for the pipeline it is currently running.
 *
 * These are produced by `executePipelineFile` / `main` in
 * `pipeline-execution-part-results.ts` (their `autoContext` blocks) plus the
 * trace keys written onto the finished result context.  A nested pipeline must
 * derive its own values — inheriting the parent's would, for example, hand the
 * child the parent's `__pipeline_options` and start timestamp — so they are
 * removed from the context handed down.  `mission_id` is deliberately absent:
 * it is user-level identity, and the child re-derives `mission_dir` /
 * `mission_tier` / `mission_evidence_dir` from it.
 */
export const ENGINE_INTERNAL_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  '__pipeline_options',
  '_knowledge_scope',
  'repo_root',
  'platform_name',
  'node_options',
  'run_utc_now',
  'browser_session_id',
  'mission_dir',
  'mission_tier',
  'mission_evidence_dir',
  'trace_summary',
  'trace_persisted_path',
]);

function readPipelineAncestry(ctx: Record<string, unknown>): string[] {
  const raw = ctx[PIPELINE_ANCESTRY_CONTEXT_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Strip engine-derived context from the data handed to a nested pipeline so
 * the child computes its own engine context instead of inheriting the
 * parent's.  Everything else — the user-level channels the parent produced —
 * is forwarded unchanged.
 *
 * The engine-internal set is enumerable, so it is listed explicitly above; the
 * `__` prefix is additionally treated as the engine's private namespace so a
 * future internal key cannot silently start leaking into children.
 */
export function sanitizeNestedPipelineContext(
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (ENGINE_INTERNAL_CONTEXT_KEYS.has(key)) continue;
    if (key.startsWith('__')) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Extend the nesting ancestry with the child pipeline about to be executed,
 * rejecting cycles and runaway depth before the child is dispatched.
 *
 * Throws a `[PIPELINE_NESTING_CYCLE]` / `[PIPELINE_NESTING_DEPTH]` error whose
 * message spells out the offending chain.
 */
export function resolveNestedPipelineAncestry(
  ctx: Record<string, unknown>,
  rootDir: string,
  parentPath: string | undefined,
  childPath: string
): string[] {
  const ancestry = readPipelineAncestry(ctx);
  if (ancestry.length === 0 && parentPath) {
    ancestry.push(nodePath.resolve(rootDir, parentPath));
  }
  const resolvedChild = nodePath.resolve(rootDir, childPath);
  const display = (absolute: string) => nodePath.relative(rootDir, absolute) || absolute;
  if (ancestry.includes(resolvedChild)) {
    throw new Error(
      `[PIPELINE_NESTING_CYCLE] core:run_pipeline would re-enter a pipeline already running: ` +
        `${[...ancestry, resolvedChild].map(display).join(' -> ')}`
    );
  }
  const nextAncestry = [...ancestry, resolvedChild];
  if (nextAncestry.length > MAX_PIPELINE_NESTING_DEPTH) {
    throw new Error(
      `[PIPELINE_NESTING_DEPTH] core:run_pipeline exceeded the maximum nesting depth of ` +
        `${MAX_PIPELINE_NESTING_DEPTH}: ${nextAncestry.map(display).join(' -> ')}`
    );
  }
  return nextAncestry;
}

/**
 * Build the context for a nested pipeline: user-level parent data, explicit
 * `params.context` overrides, and the nesting ancestry.
 */
export function buildNestedPipelineContext(
  ctx: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
  ancestry: readonly string[]
): Record<string, unknown> {
  return {
    ...sanitizeNestedPipelineContext(ctx),
    ...(overrides || {}),
    [PIPELINE_ANCESTRY_CONTEXT_KEY]: [...ancestry],
  };
}

export function resolveEngineStepType(step: PipelineAdfStep): 'apply' | 'control' {
  const normalizedOp = normalizePipelineOp(step.op);
  const [domain, action] = normalizedOp.split(':');
  return domain === 'core' && CONTROL_ACTIONS.has(action) ? 'control' : 'apply';
}

export function prepareEngineSteps(steps: PipelineAdfStep[]): AdfStep[] {
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

export function parseFragmentJson(fragmentRaw: string, fragmentRef: string): any {
  try {
    return parseSafeJsonInput(fragmentRaw, `pipeline fragment ${fragmentRef}`);
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

async function domainOps() {
  return import('./pipeline-domain-ops.js');
}

export function isSkip(value: unknown): value is AdfSkippedStep {
  return Boolean(value) && typeof value === 'object' && (value as any).skipped === true;
}

export async function dispatchReasoningLeaf(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  stepPolicy: ReasoningStepPolicy
): Promise<Record<string, unknown>> {
  const { getReasoningBackend } = await import('@agent/core/reasoning/reasoning-backend');
  const { installReasoningBackends } = await import('@agent/core/reasoning/reasoning-bootstrap');
  const { getReasoningRuntimeInstructions, renderRuntimeInstructions } =
    await import('@agent/core/reasoning/reasoning-runtime-instructions');
  installReasoningBackends();
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
  const routeOptions = await resolvePipelineReasoningOptions(
    stepPolicy,
    ctx,
    String(params._step_id || params.step_id || 'reasoning'),
    undefined
  );
  const facetNote = await resolvePipelineFacetNote(params, ctx);
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

/**
 * HA-04: route each child-script tool call back through the normal typed-op
 * dispatch. The child receives only the returned value; its intermediate
 * context never becomes the parent pipeline context.
 */
export async function dispatchProgrammaticToolCall(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  rootDir: string,
  shellBin: SafeShell,
  opts: RunStepsOptions,
  stepPolicy: ReasoningStepPolicy
): Promise<Record<string, unknown>> {
  const resolveList = (value: unknown): unknown[] =>
    Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? resolveVars(item, ctx) : item))
      : [];
  const allowedOps = resolveList(params.allowed_ops ?? params.allowedOps);
  const grantedOps = resolveList(params.granted_ops ?? params.grantedOps ?? ctx.__ptc_granted_ops);
  const { executeProgrammaticToolCall } = await import('@agent/core/programmatic-tool-calling');
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
export async function hasBoundApproval(
  step: PipelineAdfStep,
  ctx: Record<string, unknown>
): Promise<boolean> {
  // ES-02: a scenario run may approve an op only when a fixture serves it,
  // so this never admits a real side effect. Unregistered -> false.
  if (typeof step.op === 'string' && step.op.includes(':')) {
    const [scenarioDomain, scenarioAction] = normalizePipelineOp(step.op).split(':');
    if (isScenarioApprovalGranted(scenarioDomain, scenarioAction)) return true;
  }
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
    const { loadApprovalRequest } = await import('@agent/core/governance/approval-store');
    const request = loadApprovalRequest(decision.storage_channel, decision.approval_request_id);
    return (
      (request?.status === 'approved' || request?.status === 'applied') &&
      request.requestedByContext?.stepId === decision.step_id &&
      request.requestedByContext?.targetStepId === step.id
    );
  } catch {
    return false;
  }
}

/** All non-control ops (system:*, core:wait/run_janitor/transform/ptc, reasoning:*, actuator dispatch). */
type InlineOpDispatchContext = {
  step: PipelineAdfStep;
  domain: string;
  action: string;
  params: Record<string, unknown>;
  ctx: Record<string, unknown>;
  rootDir: string;
  shellBin: SafeShell;
  opts: RunStepsOptions;
  stepPolicy: ReasoningStepPolicy;
};

type InlineOpHandler = (dctx: InlineOpDispatchContext) => unknown;

const INLINE_OP_HANDLERS: Record<string, InlineOpHandler> = {
  'core:ptc': async (dctx) => {
    const { params, ctx, opts, rootDir, shellBin, stepPolicy } = dctx;

    return dispatchProgrammaticToolCall(params, ctx, rootDir, shellBin, opts, stepPolicy);
  },
  'core:programmatic_tool_call': async (dctx) => {
    const { params, ctx, opts, rootDir, shellBin, stepPolicy } = dctx;

    return dispatchProgrammaticToolCall(params, ctx, rootDir, shellBin, opts, stepPolicy);
  },
  'core:run_pipeline': async (dctx) => {
    const { params, ctx, opts, rootDir } = dctx;

    if (!opts.runPipelineFile) {
      throw new Error(
        'core:run_pipeline requires the library pipeline runner; direct nested process spawning is not allowed'
      );
    }
    const inputPath = String(params.input ?? params.pipeline ?? params.path ?? '').trim();
    if (!inputPath) throw new Error('core:run_pipeline requires an input path');
    // Guard the in-process nesting stack before dispatching: a cycle or an
    // unbounded chain would otherwise recurse until the JS stack is exhausted.
    const ancestry = resolveNestedPipelineAncestry(ctx, rootDir, opts.pipelinePath, inputPath);
    // The child receives user-level data only; engine-derived context
    // (`__pipeline_options`, `repo_root`, `run_utc_now`, mission paths, ...)
    // is stripped so the nested pipeline computes its own.
    //
    // Out of scope here: `executePipelineFile` re-fires `session_start` /
    // `before_agent_start` lifecycle hooks for every nested run, so a hook
    // observes one event per pipeline rather than one per outermost run.
    // That re-firing semantics is intentionally left unchanged.
    const nestedContext = buildNestedPipelineContext(
      ctx,
      params.context && typeof params.context === 'object' && !Array.isArray(params.context)
        ? (params.context as Record<string, unknown>)
        : undefined,
      ancestry
    );
    const nested = await opts.runPipelineFile(inputPath, {
      context: nestedContext,
      quiet: opts.quiet,
      hasHuman: opts.hasHuman,
    });
    const exportKey = String(params.export_as || 'pipeline_result');
    return {
      ...ctx,
      [exportKey]: {
        status: nested.status || 'succeeded',
        results: nested.results,
        context: nested.context,
      },
    };
  },
  'system:log': async (dctx) => {
    const { params, ctx } = dctx;

    logger.info(resolveLogMessage(params, ctx));
    return ctx;
  },
  'system:exec': async (dctx) => {
    const { params, ctx, rootDir } = dctx;

    return runInlineSystemExec(params, ctx, rootDir);
  },
  'system:write_file': async (dctx) => {
    const { params, ctx, rootDir } = dctx;

    return runInlineSystemWriteFile(params, ctx, rootDir);
  },
  'system:shell': async (dctx) => {
    const { params, ctx, rootDir, shellBin } = dctx;

    return runInlineSystemShell(params, ctx, rootDir, shellBin);
  },
  'core:wait': async (dctx) => {
    const { params, ctx } = dctx;

    return runInlineCoreWait(params, ctx);
  },
  'core:run_janitor': async (dctx) => {
    const { step, params, ctx } = dctx;

    return runInlineCoreJanitor(step, params, ctx);
  },
  'core:run-janitor': async (dctx) => {
    const { step, params, ctx } = dctx;

    return runInlineCoreJanitor(step, params, ctx);
  },
  'core:run_mission_hygiene': async (dctx) => {
    const { step, params, ctx } = dctx;

    return runInlineCoreMissionHygiene(step, params, ctx);
  },
  'core:parse_proposal_brief': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineProposalBriefParse(step, params, ctx);
  },
  'core:validate_productivity_dry_run': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineProductivityDryRunValidation(step, params, ctx);
  },
  'core:calculate_productivity_score': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineProductivityScore(step, params, ctx);
  },
  'core:grant_voice_consent': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineVoiceConsentGrant(step, params, ctx);
  },
  'core:run_vitest': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineVitest(step, params, ctx);
  },
  'core:apply_onboarding': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineOnboardingApply(step, params, ctx);
  },
  'core:run_campaign_suite': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineCampaignSuite(step, params, ctx);
  },
  'core:run_ai_audit': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineAiAudit(step, params, ctx);
  },
  'core:run_first_win_lifecycle': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineFirstWinLifecycle(step, params, ctx);
  },
  'core:run_dependency_vulnerability_scan': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineDependencyVulnerabilityScan(step, params, ctx);
  },
  'core:run_health_degradation_watch': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineHealthDegradationWatch(step, params, ctx);
  },
  'core:run_ui_ux_governance': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineUiUxGovernanceAudit(step, params, ctx);
  },
  'core:run_tenant_drift_watch': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineTenantDriftWatch(step, params, ctx);
  },
  'core:organization_digest': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineOrganizationDigest(step, params, ctx);
  },
  'core:organization_record_run': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineOrganizationRecordRun(step, params, ctx);
  },
  'core:run_auto_checkpoint': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineAutoCheckpoint(step, params, ctx);
  },
  'core:run_backup_create': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineBackupCreate(step, params, ctx);
  },
  'core:run_backup_restore_drill': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineBackupRestoreDrill(step, params, ctx);
  },
  'core:run_software_quality_report': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineSoftwareQualityReport(step, params, ctx);
  },
  'core:run_soak_endurance': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineSoakEndurance(step, params, ctx);
  },
  'core:run_soak_restart_e2e': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineSoakRestartE2E(step, params, ctx);
  },
  'core:run_marketing_video_dry_run': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineMarketingVideoDryRun(step, params, ctx);
  },
  'core:run_compliance_scan': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineComplianceScan(step, params, ctx);
  },
  'core:run_mesh_delivery': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineMeshDelivery(step, params, ctx);
  },
  'core:run_promote_procedure': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlinePromoteProcedure(step, params, ctx);
  },
  'core:run_i18n_hardcoding': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineI18nHardcoding(step, params, ctx);
  },
  'core:run_catalog_integrity': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineCatalogIntegrity(step, params, ctx);
  },
  'core:run_translation_coverage': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineTranslationCoverage(step, params, ctx);
  },
  'core:run_doc_examples_check': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineDocExamplesCheck(step, params, ctx);
  },
  'core:run_registry_manager': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineRegistryManager(step, params, ctx);
  },
  'core:run_mission_create': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineMissionCreate(step, params, ctx);
  },
  'core:run_mission_start_from_issues': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineMissionStartFromIssues(step, params, ctx);
  },
  'core:capture_avatar_photo': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineCaptureAvatarPhoto(step, params, ctx);
  },
  'core:generate_avatar': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineGenerateAvatar(step, params, ctx);
  },
  'core:register_avatar': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineRegisterAvatar(step, params, ctx);
  },
  'core:run_oauth_setup': async (dctx) => {
    const { step, params, ctx } = dctx;

    return (await domainOps()).runInlineOAuthSetup(step, params, ctx);
  },
  'core:transform': async (dctx) => {
    const { step, params, ctx } = dctx;

    return runInlineCoreTransform(step, params, ctx);
  },
  'reasoning:analyze': async (dctx) => {
    const { step, params, ctx, stepPolicy } = dctx;

    return dispatchReasoningLeaf(
      { ...params, _facets: step.facets, _step_id: step.id || step.op },
      ctx,
      stepPolicy
    );
  },
  'reasoning:transform': async (dctx) => {
    const { step, params, ctx, stepPolicy } = dctx;

    return dispatchReasoningLeaf(
      { ...params, _facets: step.facets, _step_id: step.id || step.op },
      ctx,
      stepPolicy
    );
  },
  'reasoning:synthesize': async (dctx) => {
    const { step, params, ctx, stepPolicy } = dctx;

    return dispatchReasoningLeaf(
      { ...params, _facets: step.facets, _step_id: step.id || step.op },
      ctx,
      stepPolicy
    );
  },
};

export async function dispatchLeafOp(
  step: PipelineAdfStep,
  ctx: Record<string, unknown>,
  rootDir: string,
  shellBin: SafeShell,
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

  const approvalGranted = await hasBoundApproval(step, ctx);
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
  // Pipeline params may contain typed whole-value templates (for example
  // `{{items}}` or `{{dry_run}}`). Resolve them before applying the op
  // contract so the validator sees the value the actuator will receive.
  params = resolveParamsRecursive(params, ctx) as Record<string, unknown>;

  // ES-02: a registered scenario runner serves (or fails closed) leaf ops
  // before any inline, composite (ptc / run_pipeline) or real actuator
  // dispatch, so an op a fixture was approved for is always fixture-served.
  // Unregistered -> null.
  const scenarioOperation = resolveScenarioOpOverride(domain, action);
  if (scenarioOperation) {
    validatePipelineOpInput(domain, action, params);
    return dispatchResolvedActuatorOperation(
      step,
      domain,
      action,
      params,
      ctx,
      opts,
      stepPolicy,
      scenarioOperation
    );
  }

  const inlineHandler = INLINE_OP_HANDLERS[`${domain}:${action}`];
  if (inlineHandler) {
    return (await inlineHandler({
      step,
      domain,
      action,
      params,
      ctx,
      rootDir,
      shellBin,
      opts,
      stepPolicy,
    })) as Record<string, unknown>;
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
  return dispatchResolvedActuatorOperation(
    step,
    domain,
    action,
    params,
    ctx,
    opts,
    stepPolicy,
    resolvedOperation
  );
}

async function dispatchResolvedActuatorOperation(
  step: PipelineAdfStep,
  domain: string,
  action: string,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  opts: RunStepsOptions,
  stepPolicy: ReasoningStepPolicy,
  resolvedOperation: ResolvedActuatorOperation | null
): Promise<Record<string, unknown>> {
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
        `Source op ${step.op} returned no data for channel "${exportKey}". Check that the query, path, or topic is valid and that the current persona has read access. Run \`pnpm kyberion doctor\` to verify credential and capability prerequisites.`
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
