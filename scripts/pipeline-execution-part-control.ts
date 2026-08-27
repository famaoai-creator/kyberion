import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import {
  validateAndRepairAdf,
  recordGovernanceAction,
  TraceContext,
  finalizeAndPersist,
  persistTrace,
  classifyError,
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
import {
  formatPipelineFailure,
  logNextActionForPipelineFailure,
  type PipelineFailure,
} from './pipeline-result-reporting.js';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectScript } from './lib/harness.js';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
import { runStepHooks } from './refactor/step-hooks.js';
import { buildPipelinePromptVisibilityContext } from './pipeline-reasoning-visibility.js';
import {
  runInlineProductivityDryRunValidation,
  runInlineProductivityScore,
  runInlineVoiceConsentGrant,
  runInlineProposalBriefParse,
  runInlineVitest,
  runInlineOnboardingApply,
  runInlineCampaignSuite,
  runInlineAiAudit,
  runInlineFirstWinLifecycle,
  runInlineDependencyVulnerabilityScan,
  runInlineHealthDegradationWatch,
  runInlineUiUxGovernanceAudit,
  runInlineTenantDriftWatch,
  runInlineAutoCheckpoint,
  runInlineBackupCreate,
  runInlineBackupRestoreDrill,
  runInlineSoftwareQualityReport,
  runInlineSoakEndurance,
  runInlineSoakRestartE2E,
  runInlineMarketingVideoDryRun,
  runInlineComplianceScan,
  runInlineMeshDelivery,
  runInlinePromoteProcedure,
  runInlineI18nHardcoding,
  runInlineCatalogIntegrity,
  runInlineTranslationCoverage,
  runInlineDocExamplesCheck,
  runInlineRegistryManager,
  runInlineMissionCreate,
  runInlineMissionStartFromIssues,
  runInlineCaptureAvatarPhoto,
  runInlineGenerateAvatar,
  runInlineRegisterAvatar,
  runInlineOAuthSetup,
} from './pipeline-domain-ops.js';

import {
  registeredEnv,
  resolveStepType,
  resolveExportKey,
  runTsFallbackPipeline,
  recordFallbackOutcome,
  tryPermissionFallback,
  finalizePipelineTrace,
  normalizeStepBudget,
  normalizeReasoningPolicy,
  summarizeReasoningPolicy,
  buildReasoningPolicyNote,
  resolvePipelineReasoningOptions,
  resolvePipelineFacetNote,
  runPipelineReportPhase,
  isReasoningBudgetExceeded,
  validateFlow,
  formatFlowValidationErrors,
  dispatchCache,
  moduleCache,
  resolvePipelineHumanPresence,
  PipelineSuspendedError,
  resolveParamsRecursive,
  ActuatorStepFailedError,
  loadActuatorDispatch,
  normalizePipelineOp,
  validatePipelineOpInput,
  resolveLogMessage,
  resolveActuatorManifestPath,
  assertPipelineStepCapabilityAvailable,
  globToRegExp,
  matchesArtifactPattern,
  resolveFragmentPath,
  shouldUseSubagentForReasoningStep,
  coercePositiveInt,
  runParallelBatches,
  runInlineSystemExec,
  runInlineSystemWriteFile,
  runInlineSystemShell,
  runInlineCoreWait,
  runInlineCoreJanitor,
  runInlineCoreTransform,
  CONTROL_ACTIONS,
} from './pipeline-execution-part-bootstrap.js';
import type {
  RunStepResult,
  NormalizedStepBudget,
  ReasoningStepPolicy,
  FlowValidationError,
  DispatchFunc,
  RunStepsOptions,
} from './pipeline-execution-part-bootstrap.js';
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

export function isSkip(value: unknown): value is AdfSkippedStep {
  return Boolean(value) && typeof value === 'object' && (value as any).skipped === true;
}

export async function dispatchReasoningLeaf(
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

/**
 * HA-04: route each child-script tool call back through the normal typed-op
 * dispatch. The child receives only the returned value; its intermediate
 * context never becomes the parent pipeline context.
 */
export async function dispatchProgrammaticToolCall(
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
export function hasBoundApproval(step: PipelineAdfStep, ctx: Record<string, unknown>): boolean {
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
export async function dispatchLeafOp(
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
  // Pipeline params may contain typed whole-value templates (for example
  // `{{items}}` or `{{dry_run}}`). Resolve them before applying the op
  // contract so the validator sees the value the actuator will receive.
  params = resolveParamsRecursive(params, ctx) as Record<string, unknown>;

  if (domain === 'core' && (action === 'ptc' || action === 'programmatic_tool_call')) {
    return dispatchProgrammaticToolCall(params, ctx, rootDir, shellBin, opts, stepPolicy);
  }

  if (domain === 'core' && action === 'run_pipeline') {
    if (!opts.runPipelineFile) {
      throw new Error(
        'core:run_pipeline requires the library pipeline runner; direct nested process spawning is not allowed'
      );
    }
    const inputPath = String(params.input ?? params.pipeline ?? params.path ?? '').trim();
    if (!inputPath) throw new Error('core:run_pipeline requires an input path');
    const nestedContext =
      params.context && typeof params.context === 'object' && !Array.isArray(params.context)
        ? { ...ctx, ...(params.context as Record<string, unknown>) }
        : ctx;
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
  if (domain === 'core' && action === 'parse_proposal_brief') {
    return runInlineProposalBriefParse(step, params, ctx);
  }
  if (domain === 'core' && action === 'validate_productivity_dry_run') {
    return runInlineProductivityDryRunValidation(step, params, ctx);
  }
  if (domain === 'core' && action === 'calculate_productivity_score') {
    return runInlineProductivityScore(step, params, ctx);
  }
  if (domain === 'core' && action === 'grant_voice_consent') {
    return runInlineVoiceConsentGrant(step, params, ctx);
  }
  if (domain === 'core' && action === 'run_vitest') {
    return runInlineVitest(step, params, ctx);
  }
  if (domain === 'core' && action === 'apply_onboarding') {
    return runInlineOnboardingApply(step, params, ctx);
  }
  if (domain === 'core' && action === 'run_campaign_suite') {
    return runInlineCampaignSuite(step, params, ctx);
  }
  if (domain === 'core' && action === 'run_ai_audit') return runInlineAiAudit(step, params, ctx);
  if (domain === 'core' && action === 'run_first_win_lifecycle') {
    return runInlineFirstWinLifecycle(step, params, ctx);
  }
  if (domain === 'core' && action === 'run_dependency_vulnerability_scan') {
    return runInlineDependencyVulnerabilityScan(step, params, ctx);
  }
  if (domain === 'core' && action === 'run_health_degradation_watch') {
    return runInlineHealthDegradationWatch(step, params, ctx);
  }
  if (domain === 'core' && action === 'run_ui_ux_governance') {
    return runInlineUiUxGovernanceAudit(step, params, ctx);
  }
  if (domain === 'core' && action === 'run_tenant_drift_watch') {
    return runInlineTenantDriftWatch(step, params, ctx);
  }
  if (domain === 'core' && action === 'run_auto_checkpoint')
    return runInlineAutoCheckpoint(step, params, ctx);
  if (domain === 'core' && action === 'run_backup_create')
    return runInlineBackupCreate(step, params, ctx);
  if (domain === 'core' && action === 'run_backup_restore_drill')
    return runInlineBackupRestoreDrill(step, params, ctx);
  if (domain === 'core' && action === 'run_software_quality_report')
    return runInlineSoftwareQualityReport(step, params, ctx);
  if (domain === 'core' && action === 'run_soak_endurance')
    return runInlineSoakEndurance(step, params, ctx);
  if (domain === 'core' && action === 'run_soak_restart_e2e')
    return runInlineSoakRestartE2E(step, params, ctx);
  if (domain === 'core' && action === 'run_marketing_video_dry_run')
    return runInlineMarketingVideoDryRun(step, params, ctx);
  if (domain === 'core' && action === 'run_compliance_scan')
    return runInlineComplianceScan(step, params, ctx);
  if (domain === 'core' && action === 'run_mesh_delivery')
    return runInlineMeshDelivery(step, params, ctx);
  if (domain === 'core' && action === 'run_promote_procedure')
    return runInlinePromoteProcedure(step, params, ctx);
  if (domain === 'core' && action === 'run_i18n_hardcoding')
    return runInlineI18nHardcoding(step, params, ctx);
  if (domain === 'core' && action === 'run_catalog_integrity')
    return runInlineCatalogIntegrity(step, params, ctx);
  if (domain === 'core' && action === 'run_translation_coverage')
    return runInlineTranslationCoverage(step, params, ctx);
  if (domain === 'core' && action === 'run_doc_examples_check')
    return runInlineDocExamplesCheck(step, params, ctx);
  if (domain === 'core' && action === 'run_registry_manager')
    return runInlineRegistryManager(step, params, ctx);
  if (domain === 'core' && action === 'run_mission_create')
    return runInlineMissionCreate(step, params, ctx);
  if (domain === 'core' && action === 'run_mission_start_from_issues')
    return runInlineMissionStartFromIssues(step, params, ctx);
  if (domain === 'core' && action === 'capture_avatar_photo')
    return runInlineCaptureAvatarPhoto(step, params, ctx);
  if (domain === 'core' && action === 'generate_avatar')
    return runInlineGenerateAvatar(step, params, ctx);
  if (domain === 'core' && action === 'register_avatar')
    return runInlineRegisterAvatar(step, params, ctx);
  if (domain === 'core' && action === 'run_oauth_setup')
    return runInlineOAuthSetup(step, params, ctx);
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
