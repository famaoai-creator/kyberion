import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation/env';
import { createHash } from 'node:crypto';
import { currentExecutionScope } from '@agent/core/foundation';
import {
  currentScopeEnvelope,
  runtimeScopeIdentity,
  mintScopeEnvelope,
  narrowScopeEnvelope,
  withScopeEnvelope,
} from '@agent/core/scope-envelope';
import { resolveIdentityContext, withExecutionContextAsync } from '@agent/core/authority';
import { nowIso } from '@agent/core/foundation/time';
import { parseSafeJsonObjectInput } from '@agent/core/foundation/safe-json';
import { TraceContext, finalizeAndPersist } from '@agent/core/trace';
import { logger } from '@agent/core/core';
import { findMissionPath, missionEvidenceDir, pathResolver } from '@agent/core/path-resolver';
import { pipelineBootstrapNeeds } from '@agent/core/reasoning/pipeline-bootstrap-needs';
import { killSwitch } from '@agent/core/governance/kill-switch';
import { runAdfLifecycle } from '@agent/core/pipeline/adf-lifecycle';
import { getDefaultWorkerEventStream } from '@agent/core/workforce/worker-event-stream';
import {
  fireLifecycleHooks,
  getDefaultLifecycleHookEngine,
} from '@agent/core/lifecycle-hook-engine';
import { type ReasoningPayloadScope } from '@agent/core/reasoning/reasoning-egress-scope';
import {
  createPipelineRunJournal,
  loadPipelineRunJournal,
  newPipelineRunId,
  openPipelineRunJournal,
  pipelineRunJournalPath,
  type PipelineRunJournalHandle,
  type PipelineRunJournalState,
  type PipelineJournalScope,
} from '@agent/core/pipeline/pipeline-run-journal';
import { isBuiltinPipelineResource } from '@agent/core/trust-requiring-resources';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

import * as nodePath from 'node:path';
import {
  type PipelineAdfStep,
  type PipelineStepResult,
} from '@agent/core/pipeline/pipeline-contract';
import {
  formatPipelineFailure,
  logNextActionForPipelineFailure,
} from './pipeline-result-reporting.js';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { currentProcessArgv, exitProcess, ScriptExitError } from './lib/harness.js';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
import { runSteps } from './pipeline-execution-part-execution.js';

import {
  assertPipelineExecutionCurrent,
  registeredEnv,
  tryPermissionFallback,
  finalizePipelineTrace,
  validateFlow,
  formatFlowValidationErrors,
  resolvePipelineHumanPresence,
  normalizePipelineOp,
  PipelineSuspendedError,
} from './pipeline-execution-part-bootstrap.js';
import type { RunStepsOptions } from './pipeline-execution-part-bootstrap.js';
import {
  withDelegatedExecutionFrame,
  withDelegatedExecutionOptions,
} from '@agent/core/governance/delegated-execution';
import { registerPipelineFileRunner } from './lib/pipeline-file-runner.js';
import {
  assertDiagnosticPipelineProfile,
  assertDiagnosticHooksAbsent,
  firePipelineLifecycleHooks,
  DIAGNOSTIC_OPERATOR_GUIDANCE,
  type PipelineExecutionMode,
} from './pipeline-diagnostic-profile.js';
import { assertFrontDeskReceiptPipeline } from '@agent/core/surface/front-desk-execution-contract';
/** Validate Typed Flow channel integrity before allowing any step side effects. */
export class TypedFlowValidationError extends Error {
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
  assertDiagnosticPipelineProfile(opts.executionMode, opts.pipelinePath, steps);
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
          opts.executionMode === undefined && opts.pipelinePath && !opts._adfRepairAttempted
            ? async (draft, failure) => {
                opts._adfRepairAttempted = true;
                const { attemptAutonomousRepair } = await import('@agent/core/autonomous-repair');
                const repaired = await attemptAutonomousRepair({
                  failure: {
                    category:
                      failure instanceof TypedFlowValidationError ? 'typed_flow' : 'preflight',
                    detail: failure instanceof Error ? failure.message : String(failure),
                    repairAction: 'repair the typed pipeline flow and re-run preflight',
                  },
                  step: { op: 'core:validate_flow' },
                  pipelinePath: opts.pipelinePath,
                  trustResolved: opts.trustResolved,
                  projectTrustApprovalId: opts.projectTrustApprovalId,
                });
                if (!repaired) {
                  throw new TypedFlowValidationError(validateFlow(draft, initialCtx));
                }
                return (
                  await readValidatedWorkflowAdf(opts.pipelinePath!, {
                    trustResolved: opts.trustResolved,
                    projectTrustApprovalId: opts.projectTrustApprovalId,
                  })
                ).steps;
              }
            : undefined,
        commit: (prepared) => prepared,
        execute: (committed) => runSteps(committed, initialCtx, opts),
      })
    ).result;
  } catch (error) {
    if (!(error instanceof TypedFlowValidationError)) throw error;

    const message = error.message + (opts.executionMode ? '; ' + DIAGNOSTIC_OPERATOR_GUIDANCE : '');
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

async function installReasoningBackendsForSteps(
  steps: readonly PipelineAdfStep[]
): Promise<boolean> {
  const needs = pipelineBootstrapNeeds(steps, normalizePipelineOp);
  if (!needs.required) {
    logger.debug(
      '[pipeline] reasoning bootstrap skipped; no step requires reasoning, speech, or secrets'
    );
    return false;
  }
  logger.debug(`[pipeline] reasoning bootstrap required: ${needs.reasons.join(', ')}`);
  const { installReasoningBackends } = await import('@agent/core/reasoning/reasoning-bootstrap');
  installReasoningBackends();
  return true;
}

async function recordPipelineFeedback(
  pipelineId: string,
  status: 'succeeded' | 'failed',
  trace: unknown
): Promise<void> {
  const { runFeedbackLoop } = await import('@agent/core/feedback-loop');
  runFeedbackLoop(pipelineId, status, trace as Parameters<typeof runFeedbackLoop>[2]);
}

export interface ExecutePipelineFileOptions {
  /** Task caller retains the live claim fence across human suspension. */
  resumeOwner?: 'task';
  /** Trusted host identity; never read from ADF/context flags. */
  delegatedWorkItem?: { id: string; tenantSlug: string; agentId: string; attemptId?: string };
  /** Internal durable continuation, loaded from the protected journal. */
  resumeState?: PipelineRunJournalState;
  /** Trusted caller ownership/deadline fence, inherited by nested pipelines. */
  assertExecutionCurrent?: () => void;
  executionMode?: PipelineExecutionMode;
  /** Validate the exact loaded JSON bytes against the approved caller binding. */
  validateLoadedPipeline?: (pipeline: unknown, sourceText: string) => void;
  context?: Record<string, unknown>;
  trace?: TraceContext;
  quiet?: boolean;
  hasHuman?: boolean;
  /** Restrictive server-side execution mode; never populated from ADF. */
  delegatedExecution?: 'require';
  /** Explicit project-trust decision for pipeline/template loading. */
  trustResolved?: boolean;
  /** Durable human approval for the exact project-local resource being loaded. */
  projectTrustApprovalId?: string;
  /** Trusted caller's data tier for reasoning egress during this pipeline run. */
  payloadScope?: ReasoningPayloadScope;
}

/**
 * True when a library pipeline run failed before any lifecycle hook or step
 * could run (and, for delegated runs, before its run journal was created), so
 * the failure provably had no effect. Duck-typed so src and dist agree.
 */
export function isPipelineNotStartedError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { pipelineNotStarted?: unknown }).pipelineNotStarted === true
  );
}

/**
 * Library entry for callers that already run inside the Kyberion process.
 *
 * Delegated library calls own protected durable journals just like the CLI.
 * This entry deliberately shares the same validated input, ADF
 * lifecycle, actuator dispatch, trace finalization, and feedback loop rather
 * than spawning a second `run_pipeline` process.
 */
export async function executePipelineFile(
  inputPath: string,
  options: ExecutePipelineFileOptions = {}
) {
  const progress = { started: false };
  try {
    return await executePipelineFileOnce(inputPath, options, progress);
  } catch (error) {
    const tagged = error instanceof Error ? error : new Error(String(error));
    // A nested run's not-started tag must never describe this (started) run.
    if (progress.started) delete (tagged as { pipelineNotStarted?: boolean }).pipelineNotStarted;
    else Object.assign(tagged, { pipelineNotStarted: true });
    throw tagged;
  }
}

async function executePipelineFileOnce(
  inputPath: string,
  options: ExecutePipelineFileOptions,
  progress: { started: boolean }
) {
  if (
    options.executionMode &&
    (getRegisteredEnvText('MISSION_ID')?.trim() ||
      Object.prototype.hasOwnProperty.call(options.context ?? {}, 'mission_id'))
  )
    throw new Error(
      'Diagnostic cannot inherit a mission context; run it in a separate unbound diagnostic shell without MISSION_ID.'
    );
  let diagnosticSource: string | undefined;
  let loadedSource = '';
  if (options.executionMode && !options.validateLoadedPipeline)
    throw new Error('Diagnostic execution requires an approved pipeline snapshot validator');
  assertPipelineExecutionCurrent(options);
  const pipeline = await readValidatedWorkflowAdf(inputPath, {
    trustResolved: options.trustResolved,
    projectTrustApprovalId: options.projectTrustApprovalId,
    onValidatedInput: (loaded: unknown, source: string) => {
      loadedSource = source;
      options.validateLoadedPipeline?.(loaded, source);
      if (options.executionMode) {
        assertFrontDeskReceiptPipeline(source);
        diagnosticSource = source;
      }
    },
    ...(options.executionMode
      ? {
          onValidatedInput: (loaded: unknown, source: string) => {
            loadedSource = source;
            assertFrontDeskReceiptPipeline(source);
            diagnosticSource = source;
            options.validateLoadedPipeline!(loaded, source);
          },
        }
      : {}),
  });
  assertDiagnosticPipelineProfile(options.executionMode, inputPath, pipeline.steps);
  if (options.executionMode) assertDiagnosticHooksAbsent();
  const pipelineId = String(
    pipeline.pipeline_id || pipeline.id || nodePath.basename(inputPath, nodePath.extname(inputPath))
  );
  const baseContext = (pipeline.context || {}) as Record<string, unknown>;
  const effectiveTrustResolved =
    options.trustResolved === true || Boolean(options.projectTrustApprovalId);
  const missionId =
    String(
      options.context?.mission_id ||
        baseContext.mission_id ||
        getRegisteredEnvText('MISSION_ID') ||
        ''
    ) || undefined;
  const autoContext: Record<string, unknown> = {
    repo_root: pathResolver.rootDir(),
    platform_name: process.platform,
    node_options: getRegisteredEnvText('NODE_OPTIONS') || '',
    run_utc_now: nowIso(),
    __pipeline_options: pipeline.options || {},
    ...(pipeline.session_id ? { __pipeline_session_id: pipeline.session_id } : {}),
    trust_resolved: effectiveTrustResolved,
    ...(options.projectTrustApprovalId
      ? { project_trust_approval_id: options.projectTrustApprovalId }
      : {}),
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
  // Caller-supplied context overrides the pipeline's declared context, but it
  // must never override the engine-derived keys: a nested run would otherwise
  // inherit its parent's `__pipeline_options`, `repo_root`, `run_utc_now` and
  // mission paths instead of computing its own.  `core:run_pipeline` already
  // strips those on the way down (`sanitizeNestedPipelineContext`); re-applying
  // `autoContext` last keeps the invariant for every library caller.
  let mergedContext = { ...baseContext, ...(options.context || {}), ...autoContext };
  const trace =
    options.trace ||
    new TraceContext(`pipeline:${pipelineId}`, {
      ...(missionId ? { missionId } : {}),
      pipelineId,
    });
  trace.addArtifact('file', inputPath, 'Pipeline ADF input');
  const steps = (pipeline.steps || []).map((step, index) => ({
    ...step,
    id: step.id || `__step_${index}`,
    params: step.params || {},
  }));
  if (!options.executionMode) await installReasoningBackendsForSteps(steps);
  assertPipelineExecutionCurrent(options);
  // Nothing above has an effect; lifecycle hooks (extensible) and steps may.
  progress.started = true;
  const sessionStart = await firePipelineLifecycleHooks(options.executionMode, 'session_start', {
    matcher_value: pipelineId,
    pipeline_id: pipelineId,
    ...(missionId ? { mission_id: missionId } : {}),
  });
  if (sessionStart.blocked) {
    throw new Error(
      `[SAFETY_LIMIT][HOOK_BLOCKED] session_start blocked: ${sessionStart.reasons.join('; ')}`
    );
  }
  assertPipelineExecutionCurrent(options);
  const beforeAgentStart = await firePipelineLifecycleHooks(
    options.executionMode,
    'before_agent_start',
    {
      matcher_value: pipelineId,
      pipeline_id: pipelineId,
      ...(missionId ? { mission_id: missionId } : {}),
      systemPromptOptions: {
        pipelineId,
        ...(missionId ? { missionId } : {}),
        promptVisibility: 'ledgered',
        stepCount: steps.length,
      },
    }
  );
  if (beforeAgentStart.blocked) {
    throw new Error(
      `[HOOK_BLOCKED] before_agent_start blocked pipeline ${pipelineId}: ${beforeAgentStart.reasons.join('; ')}`
    );
  }
  let libraryJournal: PipelineRunJournalHandle | undefined;
  const run = (): Promise<{
    status: 'succeeded' | 'failed';
    results: PipelineStepResult[];
    context: Record<string, unknown>;
  }> =>
    withDelegatedExecutionOptions({ workItem: options.delegatedWorkItem }, () =>
      withDelegatedExecutionFrame(pathResolver.toRepoRelative(inputPath), () =>
        runValidatedSteps(steps, mergedContext, {
          trace,
          pipelinePath: inputPath,
          executionMode: options.executionMode,
          assertExecutionCurrent: options.assertExecutionCurrent,
          ...(options.executionMode
            ? {
                validateDiagnosticEffect: () =>
                  options.validateLoadedPipeline!(pipeline, diagnosticSource!),
              }
            : {}),
          quiet: options.quiet,
          hasHuman: options.hasHuman,
          delegatedExecution: options.delegatedExecution,
          runJournal: libraryJournal,
          resumeState: options.resumeState,
          runId: libraryJournal?.runId,
          trustResolved: effectiveTrustResolved,
          projectTrustApprovalId: options.projectTrustApprovalId,
          runPipelineFile: (nestedPath, nestedOptions = {}) =>
            executePipelineFile(nestedPath, {
              ...nestedOptions,
              assertExecutionCurrent: options.assertExecutionCurrent,
              delegatedExecution: options.delegatedExecution,
              delegatedWorkItem: options.delegatedWorkItem,
              trustResolved: effectiveTrustResolved,
              projectTrustApprovalId: options.projectTrustApprovalId,
            }),
        })
      )
    );
  const missionTier = String(autoContext.mission_tier || '');
  const payloadTier: 'public' | 'confidential' | 'personal' =
    missionTier === 'personal'
      ? 'personal'
      : missionTier === 'confidential'
        ? 'confidential'
        : 'public';
  const effectivePayloadScope: ReasoningPayloadScope = options.payloadScope || {
    tier: payloadTier,
    tenant_slug: registeredEnv('KYBERION_CUSTOMER')?.trim() || undefined,
    purpose: `pipeline ${pipelineId}`,
  };
  const tierRank = { public: 0, confidential: 1, personal: 2 };
  if (tierRank[effectivePayloadScope.tier] < tierRank[payloadTier]) {
    throw new Error('Pipeline payload scope cannot be lower than its mission tier.');
  }
  if (options.delegatedExecution === 'require' && !options.executionMode) {
    const scope = currentExecutionScope();
    const identity = resolveIdentityContext();
    const sourceHash = createHash('sha256').update(loadedSource).digest('hex');
    const resumed = options.resumeState?.started?.library_execution;
    if (options.resumeState) {
      if (
        !resumed ||
        options.resumeState.finished ||
        resumed.source_sha256 !== sourceHash ||
        path.resolve(pathResolver.rootDir(), options.resumeState.started!.input_path) !==
          pathResolver.rootResolve(inputPath)
      ) {
        throw new Error(
          '[PIPELINE_RESUME_DENIED] Original source identity changed or run is terminal'
        );
      }
      if (
        options.resumeState.events.some(
          (event) =>
            event.event === 'node_completed' &&
            Array.isArray(event.payload.redacted_channels) &&
            event.payload.redacted_channels.length > 0
        )
      ) {
        throw new Error(
          '[PIPELINE_RESUME_DENIED] Redacted completed outputs require explicit recovery; effects are never replayed'
        );
      }
      mergedContext = structuredClone(resumed.initial_context);
      for (const node of options.resumeState.completed_nodes.values()) {
        Object.assign(
          mergedContext,
          node.output_channels_snapshot,
          node.control_state_snapshot ?? {}
        );
      }
      libraryJournal = openPipelineRunJournal(options.resumeState);
      libraryJournal.append('run_resumed', { resumed_at: nowIso() });
    } else {
      const role = scope?.assumedRole ?? identity.role;
      if (!role || role === 'unknown')
        throw new Error('[PIPELINE_JOURNAL] Trusted execution role is required');
      const originalRunId = newPipelineRunId();
      const scopeIdentity = currentScopeEnvelope()?.identity ?? runtimeScopeIdentity();
      libraryJournal = createPipelineRunJournal(
        originalRunId,
        {
          pipeline_id: pipelineId,
          input_path: pathResolver.rootResolve(inputPath),
          pipeline_sha256: sourceHash,
          trace_id: trace.traceId,
          ...(missionId ? { mission_id: missionId } : {}),
          step_ids: steps.map((step) => step.id),
          library_execution: {
            ...(options.resumeOwner ? { resume_owner: options.resumeOwner } : {}),
            source_sha256: sourceHash,
            initial_context: structuredClone(mergedContext),
            payload_scope: effectivePayloadScope,
            identity: {
              role,
              persona:
                scope?.assumedPersona ??
                (identity.persona === 'unknown' ? undefined : identity.persona),
              tenant_slug: scope?.tenantSlug ?? effectivePayloadScope.tenant_slug,
              organization_id: scope?.organizationId,
            },
            scope_identity: {
              ...scopeIdentity,
              session_id: scopeIdentity.session_id ?? `pipeline:${originalRunId}`,
              tenant_slug: scope?.tenantSlug ?? effectivePayloadScope.tenant_slug,
              tier: effectivePayloadScope.tier,
            },
            work_item: options.delegatedWorkItem,
            trust_resolved: effectiveTrustResolved,
            project_trust_approval_id: options.projectTrustApprovalId,
          },
        },
        missionId,
        { tier: effectivePayloadScope.tier, tenantSlug: effectivePayloadScope.tenant_slug }
      );
    }
  }
  if (!libraryJournal && !options.executionMode) {
    const scope = currentScopeEnvelope()?.identity ?? runtimeScopeIdentity();
    if (
      scope.tenant_slug &&
      effectivePayloadScope.tenant_slug &&
      scope.tenant_slug !== effectivePayloadScope.tenant_slug
    )
      throw new Error('[PIPELINE_JOURNAL] Payload tenant contradicts the execution scope');
    const journalTier =
      tierRank[scope.tier] > tierRank[effectivePayloadScope.tier]
        ? scope.tier
        : effectivePayloadScope.tier;
    libraryJournal = createPipelineRunJournal(
      newPipelineRunId(),
      {
        pipeline_id: pipelineId,
        input_path: pathResolver.rootResolve(inputPath),
        pipeline_sha256: createHash('sha256').update(loadedSource).digest('hex'),
        trace_id: trace.traceId,
        ...(missionId ? { mission_id: missionId } : {}),
        step_ids: steps.map((step) => step.id),
      },
      missionId,
      { tier: journalTier, tenantSlug: scope.tenant_slug ?? effectivePayloadScope.tenant_slug }
    );
  }
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result =
      effectivePayloadScope.tier === 'public'
        ? await run()
        : await (
            await import('@agent/core/reasoning/reasoning-egress-scope')
          ).withReasoningPayloadScope(effectivePayloadScope, run);
  } catch (error) {
    if (!(error instanceof PipelineSuspendedError) || !libraryJournal) {
      if (libraryJournal)
        libraryJournal.append('run_finished', { status: 'failed', error: String(error) });
      throw error;
    }
    libraryJournal.append('run_suspended', { ...error.suspension });
    trace.addEvent('pipeline.suspended', {
      step_id: error.suspension.step_id,
      approval_request_id: error.suspension.approval_request_id,
      storage_channel: error.suspension.storage_channel,
    });
    await firePipelineLifecycleHooks(undefined, 'task_settled', {
      pipeline_id: pipelineId,
      status: 'suspended',
    });
    await firePipelineLifecycleHooks(undefined, 'session_end', {
      pipeline_id: pipelineId,
      status: 'suspended',
    });
    const persisted = finalizePipelineTrace(trace, true);
    return {
      status: 'suspended' as const,
      results: [],
      context: mergedContext,
      trace,
      persistedPath: persisted.path,
      runId: libraryJournal.runId,
      approvalRequestId: error.suspension.approval_request_id,
      storageChannel: error.suspension.storage_channel,
    };
  }
  const failed = result.results.some((entry) => entry.status === 'failed');
  if (libraryJournal)
    libraryJournal.append('run_finished', { status: failed ? 'failed' : 'succeeded' });
  // Preserve local diagnostic evidence even when a late observer makes final publication unsafe.
  const diagnosticPersisted = options.executionMode
    ? finalizePipelineTrace(trace, !failed, { localOnly: true })
    : undefined;
  assertPipelineExecutionCurrent(options);
  const settled = await firePipelineLifecycleHooks(options.executionMode, 'task_settled', {
    matcher_value: pipelineId,
    pipeline_id: pipelineId,
    status: failed ? 'failed' : 'succeeded',
    recovered: false,
  });
  if (settled.blocked) {
    logger.warn(
      `[PI-08] task_settled observer blocked after library pipeline completion: ${settled.reasons.join('; ')}`
    );
  }
  const persisted = diagnosticPersisted ?? finalizePipelineTrace(trace, !failed);
  result.context.trace_summary = persisted.trace.rootSpan.status;
  result.context.trace_persisted_path =
    nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path;
  if (!options.executionMode)
    await recordPipelineFeedback(pipelineId, failed ? 'failed' : 'succeeded', persisted.trace);
  return {
    ...result,
    trace,
    persistedPath: persisted.path,
    ...(libraryJournal ? { runId: libraryJournal.runId } : {}),
  };
}

type Print = (value: unknown) => void;

/** Resume the protected original library run, never a reconstructed command. */
export async function resumeLibraryPipelineRun(
  runId: string,
  scope: PipelineJournalScope,
  assertCallerCurrent?: () => void,
  validateSource?: (source: string) => void
) {
  assertCallerCurrent?.();
  const state = loadPipelineRunJournal(runId, undefined, scope);
  const snapshot = state.started?.library_execution;
  if (
    !snapshot ||
    state.finished ||
    !state.suspended ||
    snapshot.payload_scope.tier !== scope.tier ||
    snapshot.payload_scope.tenant_slug !== scope.tenantSlug ||
    snapshot.identity.tenant_slug !== scope.tenantSlug
  ) {
    throw new Error('[PIPELINE_RESUME_DENIED] Original scoped library execution is not resumable');
  }
  if (!snapshot.scope_identity)
    throw new Error('[PIPELINE_RESUME_DENIED] Original scope identity is missing');
  if (snapshot.resume_owner === 'task' && (!assertCallerCurrent || !validateSource))
    throw new Error(
      '[PIPELINE_RESUME_DENIED] Task-owned continuation requires its live task tool binding'
    );
  validateSource?.(
    String(safeReadFile(pathResolver.rootResolve(state.started!.input_path), { encoding: 'utf8' }))
  );
  assertCallerCurrent?.();
  const continuationPolicy = {
    read_tiers: [scope.tier],
    write_tier: scope.tier,
    purpose: snapshot.payload_scope.purpose ?? 'original pipeline continuation',
  };
  const originalPolicy = state.started?.execution_authority?.scope_policy;
  const originalEnvelope = originalPolicy
    ? mintScopeEnvelope({
        identity: snapshot.scope_identity,
        env: {},
        policy: originalPolicy,
      })
    : undefined;
  const originalContinuation = originalEnvelope
    ? narrowScopeEnvelope(originalEnvelope, {
        identity: snapshot.scope_identity,
        policy: continuationPolicy,
      })
    : undefined;
  const parentEnvelope = currentScopeEnvelope();
  const envelope = parentEnvelope
    ? narrowScopeEnvelope(parentEnvelope, {
        identity: snapshot.scope_identity,
        policy: originalContinuation?.policy ?? continuationPolicy,
      })
    : (originalContinuation ??
      mintScopeEnvelope({
        identity: snapshot.scope_identity,
        env: {},
        policy: continuationPolicy,
      }));
  return withScopeEnvelope(envelope, () =>
    withExecutionContextAsync(
      snapshot.identity.role,
      async () => {
        const coordination = await import('@agent/core/workforce/work-coordination');
        const owner = snapshot.work_item;
        const { loadApprovalRequest } = await import('@agent/core/governance/approval-store');
        const approval = loadApprovalRequest(
          state.suspended!.storage_channel,
          state.suspended!.approval_request_id
        );
        if (
          !approval ||
          approval.kind !== 'mission_gate' ||
          approval.requestedBy !== `pipeline:${runId}` ||
          approval.requestedByContext?.pipelineRunId !== runId ||
          approval.requestedByContext?.stepId !== state.suspended!.step_id ||
          approval.correlationId !== `pipeline:${runId}:${state.suspended!.step_id}` ||
          approval.scope?.tier !== scope.tier ||
          approval.scope?.tenant_slug !== scope.tenantSlug
        ) {
          throw new Error(
            '[PIPELINE_RESUME_DENIED] Approval does not bind the original scoped suspension'
          );
        }
        if (
          approval.status === 'rejected' ||
          approval.status === 'cancelled' ||
          approval.status === 'expired'
        ) {
          // This path never invokes the runner, acquires an execution lease, or grants an effect.
          const journal = openPipelineRunJournal(state);
          journal.append('run_finished', {
            status: 'aborted',
            error: `Human authorization ${approval.status}: ${approval.id}`,
          });
          if (owner)
            await coordination.finalizeDeniedSuspendedPipelineWorkItem({
              itemId: owner.id,
              runId,
              approvalRequestId: approval.id,
              storageChannel: approval.storageChannel,
              actorPeerId: owner.agentId,
              expectedAttemptId: owner.attemptId ?? '',
              tenantSlug: owner.tenantSlug,
              sourceHash: snapshot.source_sha256,
            });
          return {
            status: 'aborted' as const,
            results: [],
            context: snapshot.initial_context,
            runId,
          };
        }
        if (approval.status !== 'approved')
          throw new Error('[PIPELINE_RESUME_DENIED] Approval is not decided');
        const dotCharters = owner?.agentId.startsWith('dot:')
          ? await import('@agent/core/dot/dot-charter')
          : undefined;
        const dotExecutor = dotCharters ? await import('@agent/core/dot/dot-executor') : undefined;
        const validateDot = () => {
          if (!dotCharters || !owner) return undefined;
          const dot = dotCharters.findDotCharter(owner.agentId.slice(4))?.charter;
          if (
            !dot ||
            dot.status !== 'active' ||
            dot.authority.authority_role !== snapshot.identity.role ||
            dot.scope.tenant_slug !== owner.tenantSlug ||
            dot.scope.organization_id !== snapshot.identity.organization_id ||
            !(dot.authority.allowed_pipelines ?? []).includes(state.started!.input_path)
          ) {
            throw new Error(
              '[PIPELINE_RESUME_DENIED] Current Dot authority no longer permits this original pipeline'
            );
          }
          dotExecutor!.assertDotAccountabilityCharter(dot);
          return dot;
        };
        validateDot();
        const continuation = owner
          ? await coordination.resumeSuspendedPipelineWorkItem({
              itemId: owner.id,
              runId,
              approvalRequestId: state.suspended!.approval_request_id,
              storageChannel: state.suspended!.storage_channel,
              actorPeerId: owner.agentId,
              expectedAttemptId: owner.attemptId ?? '',
              tenantSlug: owner.tenantSlug,
              sourceHash: snapshot.source_sha256,
            })
          : undefined;
        const assertCurrent = (): void => {
          assertCallerCurrent?.();
          validateDot();
          if (!owner || !continuation) return;
          const latest = coordination.getWorkItem(owner.id);
          if (
            !latest ||
            latest.status !== 'in_progress' ||
            latest.lease_id !== continuation.lease.lease_id ||
            latest.current_attempt_id !== owner.attemptId ||
            latest.claimed_by_peer_id !== owner.agentId
          ) {
            throw new Error('[PIPELINE_RESUME_DENIED] Continuation lease or attempt changed');
          }
        };
        const release = (
          status: 'done' | 'blocked',
          awaiting?: { runId: string; approvalRequestId: string; storageChannel: string }
        ): void => {
          if (!owner || !continuation) return;
          assertCurrent();
          const latest = coordination.getWorkItem(owner.id)!;
          const previous = latest.metadata?.dot_executor;
          coordination.releaseWorkItem({
            itemId: owner.id,
            leaseId: continuation.lease.lease_id,
            actorPeerId: owner.agentId,
            nextStatus: status,
            ...(status === 'done' ? { effectDisposition: 'completed' as const } : {}),
            summary:
              status === 'done'
                ? `Pipeline ${runId} completed after approval`
                : `Pipeline ${runId} remains held`,
            metadata: {
              ...latest.metadata,
              dot_executor: {
                ...(previous && typeof previous === 'object' ? previous : {}),
                mode: 'pipeline',
                status,
                awaiting_approval: Boolean(awaiting),
                pipeline_run_id: runId,
                ...(awaiting
                  ? {
                      approval_request_id: awaiting.approvalRequestId,
                      storage_channel: awaiting.storageChannel,
                    }
                  : {}),
              },
            },
          });
        };
        try {
          const result = await executePipelineFile(
            pathResolver.rootResolve(state.started!.input_path),
            {
              delegatedExecution: 'require',
              delegatedWorkItem: owner,
              resumeState: state,
              assertExecutionCurrent: assertCurrent,
              validateLoadedPipeline: (_pipeline, source) => validateSource?.(source),
              payloadScope: snapshot.payload_scope,
              trustResolved: snapshot.trust_resolved,
              projectTrustApprovalId: snapshot.project_trust_approval_id,
              hasHuman: false,
              quiet: true,
            }
          );
          const currentDot = validateDot();
          if (owner && continuation && currentDot && result.status !== 'suspended') {
            dotExecutor!.recordDotPipelineContinuation(currentDot, continuation.item, {
              runId,
              succeeded: !result.results.some((row) => row.status === 'failed'),
            });
          }
          if (result.status === 'suspended')
            release('blocked', {
              runId: result.runId,
              approvalRequestId: result.approvalRequestId,
              storageChannel: result.storageChannel,
            });
          else release(result.results.some((row) => row.status === 'failed') ? 'blocked' : 'done');
          return result;
        } catch (error) {
          try {
            release('blocked');
          } catch {
            /* the durable lease/hold remains for recovery */
          }
          throw error;
        }
      },
      snapshot.identity.persona as Parameters<typeof withExecutionContextAsync>[2],
      snapshot.identity.tenant_slug,
      snapshot.identity.organization_id
    )
  );
}

export async function main(args?: string[], print: Print = () => undefined) {
  // Propagate resolved identity to process.env so spawned subprocesses inherit them.
  const { resolveIdentityContext } = await import('@agent/core/authority');
  const identity = resolveIdentityContext();
  if (identity.role && !getRegisteredEnvText('MISSION_ROLE')) {
    setRegisteredEnv('MISSION_ROLE', identity.role);
  }
  // `unknown` is the sentinel for "no persona resolved"; publishing it as an
  // identity would corrupt every consumer that treats a set persona as real.
  if (
    identity.persona &&
    identity.persona !== 'unknown' &&
    !getRegisteredEnvText('KYBERION_PERSONA')
  ) {
    setRegisteredEnv('KYBERION_PERSONA', identity.persona);
  }

  const effectiveArgs = args ?? currentProcessArgv().slice(2);
  const argv = await createStandardYargs(['node', 'run_pipeline', ...effectiveArgs])
    .option('input', { alias: 'i', type: 'string', required: false })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Statically assess the pipeline without dispatching tools or providers',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      describe: 'Emit a machine-readable JSON summary (dry-run report or run result) on stdout',
    })
    .option('resume', {
      type: 'string',
      describe: 'Resume a durable pipeline run by run id',
    })
    .option('journal-tier', {
      type: 'string',
      choices: ['public', 'confidential', 'personal'] as const,
    })
    .option('journal-tenant', { type: 'string' })
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
    .option('fail-on-suspend', {
      type: 'boolean',
      default: false,
      describe: 'Exit non-zero when an approval gate suspends the pipeline',
    })
    .option('trust-project', {
      type: 'boolean',
      default: false,
      describe: 'Deprecated compatibility flag; project-local resources require an approval id',
    })
    .option('project-trust-approval', {
      type: 'string',
      describe: 'Approved project-trust request id for this exact pipeline resource',
    })
    .parseSync();

  let resumeState: PipelineRunJournalState | undefined;
  if (argv.resume) {
    const runtimeScope = currentScopeEnvelope()?.identity ?? runtimeScopeIdentity();
    const resumeMissionId = resolveIdentityContext().missionId;
    let journalScope = argv['journal-tier']
      ? { tier: argv['journal-tier'], tenantSlug: argv['journal-tenant'] }
      : !resumeMissionId
        ? { tier: runtimeScope.tier, tenantSlug: runtimeScope.tenant_slug }
        : undefined;
    // Existing resumable runs keep their legacy location. Promotion does not
    // use this discovery fallback: only new protected evidence is eligible.
    if (
      journalScope &&
      !argv['journal-tier'] &&
      !safeExistsSync(pipelineRunJournalPath(String(argv.resume), undefined, journalScope))
    )
      journalScope = undefined;
    resumeState = loadPipelineRunJournal(String(argv.resume), resumeMissionId, journalScope);
    if (resumeState.started?.library_execution) {
      if (
        !journalScope ||
        argv.context ||
        (argv.input &&
          path.resolve(String(argv.input)) !==
            pathResolver.rootResolve(resumeState.started.input_path))
      ) {
        throw new Error(
          '[PIPELINE_RESUME_DENIED] Library continuation cannot replace original source or context'
        );
      }
      const result = await resumeLibraryPipelineRun(String(argv.resume), journalScope);
      if (argv.json) print({ status: result.status, run_id: String(argv.resume) });
      return;
    }
    if (!argv.input) argv.input = resumeState.started?.input_path;
  }
  if (!argv.input) throw new Error('Either --input or --resume is required.');
  const projectTrustApprovalId = argv['project-trust-approval']
    ? String(argv['project-trust-approval']).trim() || undefined
    : undefined;
  // Repository-owned pipelines are the built-in executable surface used by
  // baseline and other governed commands. Project-local resources remain
  // pre-trust unless their exact human approval request is supplied.
  const inputIsBuiltin = isBuiltinPipelineResource(pathResolver.toRepoRelative(String(argv.input)));
  const trustResolved = inputIsBuiltin && !projectTrustApprovalId;
  const effectiveTrustResolved = trustResolved || Boolean(projectTrustApprovalId);

  if (argv['dry-run']) {
    try {
      const pipeline = await readValidatedWorkflowAdf(argv.input as string, {
        trustResolved: effectiveTrustResolved,
        projectTrustApprovalId,
      });
      const { assessPipelineDryRun } = await import('@agent/core/pipeline/pipeline-dry-run');
      const report = assessPipelineDryRun(pipeline as Parameters<typeof assessPipelineDryRun>[0]);
      if (argv.json) {
        print(report);
      } else {
        print(`[pipeline-dry-run] ${report.verdict}: ${report.pipeline_id}`);
        for (const check of report.checks) print(`- ${check.status}: ${check.message}`);
        for (const action of report.next_actions) print(`next: ${action}`);
      }
      if (report.verdict === 'blocked') throw new ScriptExitError(1, '', true, report);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const report = {
        version: '1.0' as const,
        pipeline_id: String(argv.input),
        verdict: 'blocked' as const,
        side_effects: 'none' as const,
        checks: [
          {
            id: 'contract-validation',
            status: 'blocked' as const,
            message,
          },
        ],
        next_actions: message.includes('[TRUST_REQUIRED]')
          ? [
              `Request and approve project trust, then rerun with --project-trust-approval: pnpm kyberion project-trust request ${String(argv.input)}`,
            ]
          : ['Fix the pipeline ADF/guardrail validation errors and rerun the dry-run.'],
      };
      if (argv.json) {
        print(report);
        throw new ScriptExitError(1, '', true, report);
      }
      throw new ScriptExitError(1, `[pipeline-dry-run] blocked: ${report.checks[0].message}`);
    }
  }

  killSwitch.startMonitor(Number(registeredEnv('KYBERION_KILL_SWITCH_INTERVAL_MS') || 10000));

  // Safety guard: restore BlackHole mic routing on Ctrl+C or SIGTERM.
  // The pipeline's `||` fallback only fires on non-zero exit codes, not SIGINT.
  // Without this, a user pressing Ctrl+C during a meeting join pipeline would
  // leave their system microphone locked to BlackHole.
  const cleanupAndExit = (code: number) => {
    void import('@agent/core/blackhole-routing-guard')
      .then(({ resetRouterSync }) => {
        resetRouterSync();
        exitProcess(code);
      })
      .catch(() => exitProcess(code));
  };
  process.once('SIGINT', () => cleanupAndExit(130));
  process.once('SIGTERM', () => cleanupAndExit(143));

  let loadedSource: string | undefined;
  const pipeline = await readValidatedWorkflowAdf(argv.input as string, {
    trustResolved: effectiveTrustResolved,
    projectTrustApprovalId,
    ...(!String(argv.input).match(/\.(ts|js|mjs|cjs)$/u)
      ? {
          onValidatedInput: (_loaded: unknown, source: string) => {
            loadedSource = source;
          },
        }
      : {}),
  });

  const baseContext = (pipeline.context || {}) as Record<string, unknown>;
  let overrideContext: Record<string, unknown> = {};
  if (argv.context) {
    try {
      overrideContext =
        parseSafeJsonObjectInput(argv.context as string, 'pipeline --context') || {};
    } catch (err: any) {
      logger.error(`❌ [PIPELINE] Invalid --context JSON: ${err.message}`);
      throw new ScriptExitError(1, '', true);
    }
  }
  const firstNonEmpty = (...candidates: (string | undefined)[]): string | undefined =>
    candidates.find((v): v is string => typeof v === 'string' && v.length > 0);
  const missionId = firstNonEmpty(
    overrideContext.mission_id as string | undefined,
    baseContext.mission_id as string | undefined,
    getRegisteredEnvText('MISSION_ID')
  );
  const autoContext: Record<string, unknown> = {};
  // Propagate missionId to env so tier-guard can resolve ${MISSION_ID} in default_allow paths.
  if (missionId && !getRegisteredEnvText('MISSION_ID')) {
    setRegisteredEnv('MISSION_ID', missionId);
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
  autoContext.node_options = getRegisteredEnvText('NODE_OPTIONS') || '';
  autoContext.run_utc_now = nowIso();
  autoContext.__pipeline_options = pipeline.options || {};
  // The authored `session_id` is what keeps a multi-step browser scenario on
  // ONE session; `browser_session_id` above is only a display/default hint.
  if (pipeline.session_id) autoContext.__pipeline_session_id = pipeline.session_id;

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
  if (missionId) logger.info(`   [PIPELINE] Mission ID: ${missionId}`);
  if (autoContext.mission_evidence_dir)
    logger.info(`   [PIPELINE] Evidence Dir: ${autoContext.mission_evidence_dir}`);

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
    // Bootstrap reasoning before hooks and actuator dispatch, but only when a
    // step can reach it. Volatile GC and other inert pipelines skip the CLI probes.
    const reasoningRequired = await installReasoningBackendsForSteps(stepsToRun);
    const runId = resumeState?.run_id || newPipelineRunId();
    const runtimeScope = currentScopeEnvelope()?.identity ?? runtimeScopeIdentity();
    const activeRunJournal = resumeState
      ? openPipelineRunJournal(resumeState)
      : createPipelineRunJournal(
          runId,
          {
            pipeline_id: pipelineId,
            input_path: String(argv.input),
            ...(loadedSource !== undefined
              ? { pipeline_sha256: createHash('sha256').update(loadedSource).digest('hex') }
              : {}),
            trace_id: trace.traceId,
            ...(missionId ? { mission_id: missionId } : {}),
            step_ids: stepsToRun.map((step, index) => step.id || `__step_${index}`),
          },
          missionId,
          !missionId ? { tier: runtimeScope.tier, tenantSlug: runtimeScope.tenant_slug } : undefined
        );
    runJournal = activeRunJournal;
    if (resumeState) {
      activeRunJournal.append('run_resumed', { resumed_at: nowIso() });
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
        trustResolved: effectiveTrustResolved,
        projectTrustApprovalId,
        runPipelineFile: (nestedPath, nestedOptions = {}) =>
          executePipelineFile(nestedPath, {
            ...nestedOptions,
            // Nested runs cannot widen the parent's trust decision.
            trustResolved: effectiveTrustResolved,
            projectTrustApprovalId,
          }),
      });
    const result =
      payloadTier === 'public'
        ? await runSteps()
        : await (
            await import('@agent/core/reasoning/reasoning-egress-scope')
          ).withReasoningPayloadScope(
            {
              tier: payloadTier,
              tenant_slug: registeredEnv('KYBERION_CUSTOMER')?.trim() || undefined,
              purpose: `pipeline ${pipelineId}`,
            },
            runSteps
          );
    const failed = result.results.find((entry) => entry.status === 'failed');
    const failure = failed ? formatPipelineFailure(failed.error || 'unknown error') : undefined;
    const recovered = failure
      ? tryPermissionFallback(pipeline, failure, trace, {
          trustResolved: effectiveTrustResolved,
          projectTrustApprovalId,
        })
      : false;
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
    logger.info(`   [PIPELINE] Run ID: ${runId}`);
    activeRunJournal.append('run_finished', { status: pipelineStatus });
    if (argv.json) {
      // Run summary only — never the full pipeline context, which can carry
      // tier-scoped data. Logs stay on stderr / the process log file.
      print({
        pipeline_id: pipelineId,
        input: String(argv.input),
        status: pipelineStatus,
        recovered,
        run_id: runId,
        trace_id: trace.traceId,
        ...(missionId ? { mission_id: missionId } : {}),
        trace_path: result.context.trace_persisted_path,
        steps: result.results.map((entry) => ({
          op: entry.op,
          status: entry.status,
          ...(entry.error ? { error: entry.error } : {}),
        })),
        ...(failure && !recovered ? { failure: failure.summary } : {}),
      });
    }
    getDefaultWorkerEventStream().emit(
      'turn_end',
      { kind: 'pipeline', pipeline_id: pipelineId, status: pipelineStatus, recovered },
      { pipeline_id: pipelineId, ...(missionId ? { mission_id: missionId } : {}) }
    );
    await recordPipelineFeedback(pipelineId, pipelineStatus, persisted.trace);
    // LC-09: surface semantic-decision degradations in the run summary —
    // a pipeline that "succeeded" on deterministic fallbacks every time is
    // otherwise indistinguishable from one whose LLM decisions worked.
    // Inert pipelines never called the decider, so the registry stays unloaded.
    if (reasoningRequired) {
      const { getSemanticDecideDegradations } = await import('@agent/core/semantic-decide');
      const semanticDegradations = getSemanticDecideDegradations();
      if (semanticDegradations.length > 0) {
        const byReason = semanticDegradations.reduce<Record<string, number>>((acc, entry) => {
          acc[entry.reason] = (acc[entry.reason] || 0) + 1;
          return acc;
        }, {});
        const { appendSemanticDegradationRun } =
          await import('@agent/core/semantic-degradation-log');
        appendSemanticDegradationRun(pipelineId, byReason);
        logger.warn(
          `   [PIPELINE] llm_decide degraded ${semanticDegradations.length}x (${Object.entries(
            byReason
          )
            .map(([reason, count]) => `${reason}=${count}`)
            .join(', ')}) — deterministic fallbacks were used.`
        );
      }
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
        const { PROMOTION_CANDIDATE_MIN_RUNS, recordAdhocPipelineRun } =
          await import('@agent/core/promotion-candidates');
        const successCount = recordAdhocPipelineRun(inputRelative);
        if (successCount >= PROMOTION_CANDIDATE_MIN_RUNS) {
          logger.warn(
            `   [PIPELINE] This ad-hoc ADF has now succeeded ${successCount}x — promote it: pnpm pipeline:promote --input ${inputRelative} --tenant <slug>`
          );
        } else {
          logger.info(
            `   [PIPELINE] Reusable? Promote this run into the tenant catalog: pnpm pipeline:promote --input ${inputRelative} --tenant <slug>`
          );
        }
      }
      if (autoContext.__pipeline_options && (autoContext.__pipeline_options as any).keep_alive) {
        logger.info(
          '   [PROCESS] Browser session kept alive per pipeline options. Terminal will remain open.'
        );
      } else {
        return;
      }
    } else {
      if (failed) {
        logger.error(`❌ [PIPELINE] Failed step: ${failed.op} :: ${failure!.summary}`);
        logNextActionForPipelineFailure(failure!, String(argv.input));
      }
      logger.error(`❌ [PIPELINE] Failed: ${pipeline.name || argv.input}`);
      throw new ScriptExitError(1, '', true);
    }
  } catch (err: any) {
    if (err instanceof ScriptExitError) throw err;
    if (err instanceof PipelineSuspendedError) {
      trace.addEvent('pipeline.suspended', {
        step_id: err.suspension.step_id,
        approval_request_id: err.suspension.approval_request_id,
        on_timeout: err.suspension.on_timeout,
        ...(err.suspension.timeout_at ? { timeout_at: err.suspension.timeout_at } : {}),
      });
      if (agentStartAdmitted && !settledLifecycleHookEmitted) {
        settledLifecycleHookEmitted = true;
        const settled = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'task_settled', {
          matcher_value: pipelineId,
          pipeline_id: pipelineId,
          status: 'suspended',
          recovered: false,
          approval_request_id: err.suspension.approval_request_id,
        });
        if (settled.blocked) {
          logger.warn(
            `[PI-08] task_settled observer blocked after pipeline suspension: ${settled.reasons.join('; ')}`
          );
        }
      }
      const sessionEnd = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'session_end', {
        matcher_value: pipelineId,
        pipeline_id: pipelineId,
        status: 'suspended',
        approval_request_id: err.suspension.approval_request_id,
      });
      if (sessionEnd.blocked) {
        logger.warn(
          `[PI-08] session_end observer blocked after pipeline suspension: ${sessionEnd.reasons.join('; ')}`
        );
      }
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
      if (argv.failOnSuspend) throw new ScriptExitError(3, '', true);
      return;
    }
    const failure = formatPipelineFailure(err);
    const recovered = tryPermissionFallback(pipeline, failure, trace, {
      trustResolved: effectiveTrustResolved,
      projectTrustApprovalId,
    });
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
      await recordPipelineFeedback(pipelineId, 'succeeded', persisted.trace);
      logger.info(
        `   [PIPELINE] Trace: ${nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
      );
      return;
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
    await recordPipelineFeedback(pipelineId, 'failed', persisted.trace);
    logger.info(
      `   [PIPELINE] Trace: ${nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
    );
    logger.error(`❌ [PIPELINE] Error: ${failure.summary}`);
    logNextActionForPipelineFailure(failure, String(argv.input));
    throw new ScriptExitError(1, '', true);
  }
}

// Nested pipelines (scheduled organization operations) run through the port so
// the operation executor never imports the engine (runtime import cycle).
registerPipelineFileRunner(executePipelineFile);
