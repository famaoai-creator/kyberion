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
import {
  resolveEngineStepType,
  prepareEngineSteps,
  parseFragmentJson,
  isSkip,
  dispatchReasoningLeaf,
  buildPipelinePromptVisibilityContext,
  dispatchProgrammaticToolCall,
  hasBoundApproval,
  dispatchLeafOp,
  findStepByIdRecursive,
} from './pipeline-execution-part-control.js';
import {
  TypedFlowValidationError,
  runValidatedSteps,
  executePipelineFile,
  main,
  isDirectRun,
} from './pipeline-execution-part-results.js';
import type { ExecutePipelineFileOptions } from './pipeline-execution-part-results.js';

/**
 * AR-01 Phase B: retry + autonomous-repair extracted into a higher-order
 * function that wraps a single step-execution attempt, instead of being
 * loop machinery inlined in runSteps. The canonical engine
 * (executeAdfSteps) has no built-in retry, so Phase C delegation needs
 * retry/repair as something a handler opts into, not something the engine
 * itself does — this is the shape that opt-in takes.
 */
export async function runWithRepair(
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

export async function runStepsInternal(
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
