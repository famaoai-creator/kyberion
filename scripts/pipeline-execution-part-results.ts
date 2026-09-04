import {
  getRegisteredEnvText,
  nowIso,
  parseSafeJsonObjectInput,
  setRegisteredEnv,
} from '@agent/core/foundation';
import { attemptAutonomousRepair } from '@agent/core/autonomous-repair';
import { TraceContext, finalizeAndPersist } from '@agent/core/src/trace';
import { logger } from '@agent/core/core';
import { findMissionPath, missionEvidenceDir, pathResolver } from '@agent/core/path-resolver';
import { installReasoningBackends } from '@agent/core/reasoning-bootstrap';
import { runFeedbackLoop } from '@agent/core/src/feedback-loop';
import { getSemanticDecideDegradations } from '@agent/core/semantic-decide';
import { appendSemanticDegradationRun } from '@agent/core/semantic-degradation-log';
import {
  PROMOTION_CANDIDATE_MIN_RUNS,
  recordAdhocPipelineRun,
} from '@agent/core/promotion-candidates';
import { killSwitch } from '@agent/core/kill-switch';
import { resolveIdentityContext } from '@agent/core/authority';
import { runAdfLifecycle } from '@agent/core/adf-lifecycle';
import { getDefaultWorkerEventStream } from '@agent/core/worker-event-stream';
import {
  fireLifecycleHooks,
  getDefaultLifecycleHookEngine,
} from '@agent/core/lifecycle-hook-engine';
import { withReasoningPayloadScope } from '@agent/core/reasoning-egress-scope';
import {
  createPipelineRunJournal,
  loadPipelineRunJournal,
  newPipelineRunId,
  openPipelineRunJournal,
  type PipelineRunJournalHandle,
  type PipelineRunJournalState,
} from '@agent/core/pipeline-run-journal';
import { assessPipelineDryRun } from '@agent/core/pipeline-dry-run';
import { isBuiltinPipelineResource } from '@agent/core/trust-requiring-resources';

import { installPythonVoiceBridgeIfAvailable } from '@agent/core/python-voice-bridge';
import { resetRouterSync } from '@agent/core/blackhole-routing-guard';
import * as nodePath from 'node:path';
import { type PipelineAdfStep } from '@agent/core/pipeline-contract';
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
  registeredEnv,
  tryPermissionFallback,
  finalizePipelineTrace,
  validateFlow,
  formatFlowValidationErrors,
  resolvePipelineHumanPresence,
  PipelineSuspendedError,
} from './pipeline-execution-part-bootstrap.js';
import type { RunStepsOptions } from './pipeline-execution-part-bootstrap.js';
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
            ? async (draft, failure) => {
                opts._adfRepairAttempted = true;
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
  /** Explicit project-trust decision for pipeline/template loading. */
  trustResolved?: boolean;
  /** Durable human approval for the exact project-local resource being loaded. */
  projectTrustApprovalId?: string;
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
  const pipeline = await readValidatedWorkflowAdf(inputPath, {
    trustResolved: options.trustResolved,
    projectTrustApprovalId: options.projectTrustApprovalId,
  });
  const pipelineId = String(
    pipeline.pipeline_id || pipeline.id || nodePath.basename(inputPath, nodePath.extname(inputPath))
  );
  const baseContext = (pipeline.context || {}) as Record<string, unknown>;
  const effectiveTrustResolved =
    options.trustResolved === true || Boolean(options.projectTrustApprovalId);
  const missionId =
    String(options.context?.mission_id || baseContext.mission_id || process.env.MISSION_ID || '') ||
    undefined;
  const autoContext: Record<string, unknown> = {
    repo_root: pathResolver.rootDir(),
    platform_name: process.platform,
    node_options: process.env.NODE_OPTIONS || '',
    run_utc_now: nowIso(),
    __pipeline_options: pipeline.options || {},
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
  const mergedContext = { ...baseContext, ...(options.context || {}), ...autoContext };
  const trace =
    options.trace ||
    new TraceContext(`pipeline:${pipelineId}`, {
      ...(missionId ? { missionId } : {}),
      pipelineId,
    });
  trace.addArtifact('file', inputPath, 'Pipeline ADF input');
  const steps = (pipeline.steps || []).map((step) => ({ ...step, params: step.params || {} }));
  installReasoningBackends();
  const sessionStart = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'session_start', {
    matcher_value: pipelineId,
    pipeline_id: pipelineId,
    ...(missionId ? { mission_id: missionId } : {}),
  });
  if (sessionStart.blocked) {
    throw new Error(
      `[SAFETY_LIMIT][HOOK_BLOCKED] session_start blocked: ${sessionStart.reasons.join('; ')}`
    );
  }
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
        stepCount: steps.length,
      },
    }
  );
  if (beforeAgentStart.blocked) {
    throw new Error(
      `[HOOK_BLOCKED] before_agent_start blocked pipeline ${pipelineId}: ${beforeAgentStart.reasons.join('; ')}`
    );
  }
  const run = () =>
    runValidatedSteps(steps, mergedContext, {
      trace,
      pipelinePath: inputPath,
      quiet: options.quiet,
      hasHuman: options.hasHuman,
      trustResolved: effectiveTrustResolved,
      projectTrustApprovalId: options.projectTrustApprovalId,
      runPipelineFile: (nestedPath, nestedOptions = {}) =>
        executePipelineFile(nestedPath, {
          ...nestedOptions,
          trustResolved: effectiveTrustResolved,
          projectTrustApprovalId: options.projectTrustApprovalId,
        }),
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
  const settled = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'task_settled', {
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
  const persisted = finalizePipelineTrace(trace, !failed);
  result.context.trace_summary = persisted.trace.rootSpan.status;
  result.context.trace_persisted_path =
    nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path;
  runFeedbackLoop(pipelineId, failed ? 'failed' : 'succeeded', persisted.trace);
  return { ...result, trace, persistedPath: persisted.path };
}

type Print = (value: unknown) => void;

export async function main(args?: string[], print: Print = () => undefined) {
  // Propagate resolved identity to process.env so spawned subprocesses inherit them.
  const identity = resolveIdentityContext();
  if (identity.role && !process.env.MISSION_ROLE) {
    process.env.MISSION_ROLE = identity.role;
  }
  if (identity.persona && !getRegisteredEnvText('KYBERION_PERSONA')) {
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
    resumeState = loadPipelineRunJournal(String(argv.resume), process.env.MISSION_ID);
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
    exitProcess(code);
  };
  process.once('SIGINT', () => cleanupAndExit(130));
  process.once('SIGTERM', () => cleanupAndExit(143));

  const pipeline = await readValidatedWorkflowAdf(argv.input as string, {
    trustResolved: effectiveTrustResolved,
    projectTrustApprovalId,
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
  autoContext.run_utc_now = nowIso();
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
      runFeedbackLoop(pipelineId, 'succeeded', persisted.trace);
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
    runFeedbackLoop(pipelineId, 'failed', persisted.trace);
    logger.info(
      `   [PIPELINE] Trace: ${nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
    );
    logger.error(`❌ [PIPELINE] Error: ${failure.summary}`);
    logNextActionForPipelineFailure(failure, String(argv.input));
    throw new ScriptExitError(1, '', true);
  }
}
