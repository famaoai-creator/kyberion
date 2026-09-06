import { logger } from '@agent/core/core';
import {
  isRecord,
  nowIso,
  parseSafeJsonInput,
  parseSafeJsonObjectValue,
  getRegisteredEnvText,
  readJson,
} from '@agent/core/foundation';
import {
  safeReadFile,
  safeWriteFile,
  safeExec,
  safeMkdir,
  safeExistsSync,
  safeLstat,
  safeUnlinkSync,
  safeSymlinkSync,
  assertSafeRepositoryPath,
} from '@agent/core/secure-io';
import { resolveVars, evaluateCondition } from '@agent/core/logic-utils';
import { retry } from '@agent/core/async-utils';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { pathResolver } from '@agent/core/path-resolver';
import { buildUnknownActuatorOpError } from '@agent/core/actuator-op-registry';
import { registerTaskPlanCoordinator } from '@agent/core/task-plan-coordinator-port';
import { evaluateTaskPlanReadyGate } from '@agent/core/sdlc-artifact-store';
import { buildCostReportFromHistory } from '@agent/core/cost-report';
import { summarizeSemanticDegradations } from '@agent/core/semantic-degradation-log';
import { listPromotionCandidates } from '@agent/core/promotion-candidates';
import { runAdfActuatorPipeline } from '../../../core/actuator-sdk.js';
import type { AdfEngineContext, AdfRunResult, AdfStep } from '../../../core/adf-engine.js';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { executeTaskPlanFromOrchestrator, taskPlanCoordinator } from './task-plan-coordinator.js';
import { decomposeIntoTasks, taskPlanToNextTasks } from './task-plan-ops.js';
import {
  loadActuatorRequestArchetypes,
  detectRequestArchetype,
  resolveExecutionBriefInputs,
  resolveExecutionBriefReference,
  buildPipelineBundleJobs,
  renderPipelineBundleJob,
  preflightExecutionPlanSet,
  executeExecutionPlanSet,
  collectCommandHealth,
  parseJsonCommandOutput,
  buildClarificationQuestion,
  deriveExecutionBriefReadiness,
  deriveStatusNextActions,
  collectMissionStatusSnapshot,
  collectProjectStatusSnapshot,
} from './orchestrator-execution-brief-helpers.js';
import { parseIntentMapping } from './orchestrator-intent-mapping.js';

// Legacy core callers are still supported, but the coordinator is owned and
// registered by the orchestrator actuator rather than by Wisdom or core.
registerTaskPlanCoordinator(taskPlanCoordinator);

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

export type PipelineBundleJob = {
  id: string;
  title: string;
  actuator: string;
  template_path: string;
  recommended_procedure?: string;
  parameter_overrides?: Record<string, unknown>;
  outputs?: string[];
};

export type ExecutionPlanSetJob = PipelineBundleJob & {
  output_path?: string;
  rendered_pipeline?: Record<string, unknown>;
  skipped_reason?: string;
};

export type ExecutionPlanRunResult = {
  id: string;
  actuator: string;
  input_path?: string;
  status: 'succeeded' | 'failed' | 'skipped';
  skipped_reason?: string;
  output?: unknown;
  error?: string;
};

export type ExecutionPlanPreflightIssue = {
  job_id: string;
  level: 'error' | 'warning';
  code: string;
  message: string;
  repair_applied?: string;
};

export type ExecutionPlanPreflightReport = {
  kind: 'actuator-execution-plan-preflight-report';
  status: 'ready' | 'needs_clarification' | 'invalid';
  issue_count: number;
  repair_count: number;
  issues: ExecutionPlanPreflightIssue[];
};

const ORCHESTRATOR_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/orchestrator-actuator/manifest.json'
);
const DEFAULT_ORCHESTRATOR_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

function buildUnknownOrchestratorOpError(op: string): Error {
  return buildUnknownActuatorOpError('orchestrator', op);
}

export const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: ORCHESTRATOR_MANIFEST_PATH,
  defaults: DEFAULT_ORCHESTRATOR_RETRY,
  fallbackCategories: ['resource_unavailable', 'timeout'],
});

function resolveOrchestratorRepositoryPath(rootDir: string, value: unknown): string {
  return assertSafeRepositoryPath(path.resolve(rootDir, String(value || '').trim()), {
    allowMissingLeaf: true,
  });
}

function isExistingRegularFile(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

function readOrchestratorJson(filePath: string, label: string): unknown {
  if (!isExistingRegularFile(filePath)) {
    throw new Error(`${label} must be an existing regular file: ${filePath}`);
  }
  return readJson(filePath);
}

/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 */
export async function executePipeline(
  steps: PipelineStep[],
  initialCtx: AdfEngineContext = {},
  options: { max_steps?: number; timeout_ms?: number } = {}
) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || DEFAULT_MAX_PIPELINE_STEPS;
  const TIMEOUT = options.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS;

  let ctx: AdfEngineContext = {
    ...initialCtx,
    root: rootDir,
    HOME: getRegisteredEnvText('HOME') || '/Users',
  };

  const contextPath =
    typeof initialCtx.context_path === 'string' && initialCtx.context_path
      ? resolveOrchestratorRepositoryPath(rootDir, initialCtx.context_path)
      : undefined;
  if (contextPath && safeExistsSync(contextPath)) {
    const saved = parseSafeJsonObjectValue(
      readOrchestratorJson(contextPath, 'orchestrator context'),
      'orchestrator context'
    );
    ctx = { ...ctx, ...saved };
  }

  const result = await runAdfActuatorPipeline({
    actuatorId: 'orchestrator',
    steps,
    context: ctx,
    options: { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
    handlers: {
      capture: (op, params, currentCtx) => opCapture(op, params, currentCtx),
      transform: (op, params, currentCtx) => opTransform(op, params, currentCtx),
      apply: (op, params, currentCtx) => opApply(op, params, currentCtx),
      control: opControl,
    },
    hooks: {
      beforeStep: (step, stepNumber) =>
        logger.info(`  [ORCH_PIPELINE] [Step ${stepNumber}] ${step.type}:${step.op}...`),
      afterStep: (step, _stepNumber, _context, outcome) => {
        if (outcome.status === 'failed') {
          logger.error(
            `  [ORCH_PIPELINE] Step failed (${step.op}): ${outcome.error || 'unknown error'}`
          );
        }
      },
    },
  });

  ctx = result.context;

  if (contextPath) {
    safeWriteFile(contextPath, JSON.stringify(ctx, null, 2));
  }

  return result;
}

async function opControl(
  op: string,
  params: unknown,
  ctx: AdfEngineContext,
  runSteps: (
    steps: AdfStep[],
    seedCtx?: AdfEngineContext
  ) => Promise<AdfRunResult<AdfEngineContext>>,
  _resolve: (value: unknown) => unknown
): Promise<AdfEngineContext> {
  if (!isRecord(params)) {
    throw new Error(`[INVALID_PARAMS] ${op} control params must be an object`);
  }
  const runNested = async (steps: unknown, seedCtx: AdfEngineContext) => {
    const result = await runSteps(asAdfSteps(steps, op), seedCtx);
    if (result.status === 'failed') {
      throw new Error(
        result.results.find((entry) => entry.status === 'failed')?.error || 'nested pipeline failed'
      );
    }
    return result.context;
  };

  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        return runNested(params.then, ctx);
      } else if (params.else) {
        return runNested(params.else, ctx);
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter =
        typeof params.max_iterations === 'number' && params.max_iterations >= 0
          ? params.max_iterations
          : 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        ctx = await runNested(params.pipeline, ctx);
        iterations++;
      }
      return ctx;

    default:
      throw buildUnknownOrchestratorOpError(op);
  }
}

function asAdfSteps(value: unknown, op: string): AdfStep[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (step): step is AdfStep =>
        isRecord(step) &&
        typeof step.op === 'string' &&
        (step.type === 'capture' ||
          step.type === 'transform' ||
          step.type === 'apply' ||
          step.type === 'control')
    )
  ) {
    throw new Error(`[INVALID_PARAMS] ${op} control requires an array of ADF steps`);
  }
  return value;
}

async function opCapture(op: string, params: any, ctx: any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'read_json':
      const inputPath = resolveOrchestratorRepositoryPath(rootDir, resolveVars(params.path, ctx));
      return {
        ...ctx,
        [params.export_as || 'last_capture_data']: readOrchestratorJson(
          inputPath,
          'orchestrator read_json'
        ),
      };
    case 'read_file':
      return {
        ...ctx,
        [params.export_as || 'last_capture']: safeReadFile(
          resolveOrchestratorRepositoryPath(rootDir, resolveVars(params.path, ctx)),
          { encoding: 'utf8' }
        ),
      };
    case 'shell':
      const cmd = resolveVars(params.cmd, ctx);
      const shellResult = await retry(async () => safeExec(cmd), buildRetryOptions(params.retry));
      return { ...ctx, [params.export_as || 'last_capture']: shellResult.trim() };
    case 'intent_detect':
      const mapping = parseIntentMapping(
        yaml.load(
          safeReadFile(
            resolveOrchestratorRepositoryPath(rootDir, resolveVars(params.mapping_path, ctx)),
            {
              encoding: 'utf8',
            }
          ) as string
        )
      );
      if (!mapping) throw new Error('intent_detect mapping has an invalid shape');
      const query = resolveVars(params.query, ctx).toLowerCase();
      const detected = mapping.intents.find((intent) =>
        intent.trigger_phrases.some((phrase) => query.includes(phrase.toLowerCase()))
      );
      return { ...ctx, [params.export_as || 'detected_intent']: detected };
    default:
      throw buildUnknownOrchestratorOpError(op);
  }
}

async function opTransform(op: string, params: any, ctx: any) {
  switch (op) {
    case 'json_query':
      const data = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: result };
    case 'variable_hydrate':
      const input =
        typeof ctx[params.from] === 'object'
          ? JSON.stringify(ctx[params.from])
          : String(ctx[params.from]);
      const hydrated = resolveVars(input, ctx);
      return {
        ...ctx,
        [params.export_as || 'last_transform']: params.is_json
          ? parseSafeJsonInput(hydrated, 'variable_hydrate JSON')
          : hydrated,
      };
    case 'request_to_execution_brief': {
      const catalog = loadActuatorRequestArchetypes();
      const requestText = String(
        resolveVars(params.request_text || ctx.request_text || '', ctx)
      ).trim();
      if (!requestText) throw new Error('request_to_execution_brief requires request_text');
      const archetype = detectRequestArchetype(requestText, catalog);
      const providedInputs = resolveExecutionBriefInputs(params, ctx, archetype);
      const missingInputs = (archetype.required_inputs || []).filter(
        (item: string) => !providedInputs.provided.includes(item)
      );
      const reasoningMode: 'placeholder' | 'model' =
        missingInputs.length > 0 ? 'placeholder' : 'model';
      const assumptions = missingInputs.map((item: string) => `Missing input: ${item}`);
      const clarificationQuestions = missingInputs.map((item: string) => ({
        id: item,
        question: buildClarificationQuestion(item),
        reason: `The request cannot be executed safely without ${item}.`,
        default_assumption: `Proceed with a placeholder assumption for ${item}`,
        impact: 'Affects execution scope and generated deliverables.',
      }));
      const readiness = deriveExecutionBriefReadiness(missingInputs, requestText);
      const llmTouchpoints = [
        {
          stage: 'intent-normalization',
          purpose: 'Translate natural language into a governed execution brief.',
          output_contract: 'actuator-execution-brief',
        },
        {
          stage: 'human-clarification',
          purpose: 'Ask only the questions required to remove blocking ambiguity.',
          output_contract: 'operator-interaction-packet',
        },
        {
          stage: 'execution-preview',
          purpose: 'Explain plan, readiness, and expected deliverables before execution.',
          output_contract: 'operator-interaction-packet',
        },
      ];
      return {
        ...ctx,
        [params.export_as || 'execution_brief']: {
          kind: 'actuator-execution-brief',
          request_text: requestText,
          archetype_id: archetype.id,
          confidence: archetype.score,
          summary: archetype.summary_template,
          user_facing_summary: `The request was normalized as ${archetype.id}.${missingInputs.length > 0 ? ' Additional input is required.' : ' Execution planning can proceed.'}`,
          normalized_scope: archetype.normalized_scope || [],
          target_actuators: archetype.target_actuators || [],
          deliverables: archetype.deliverables || [],
          missing_inputs: missingInputs,
          provided_inputs: providedInputs.provided,
          inferred_inputs: providedInputs.inferred,
          input_bindings: providedInputs.bindings,
          reasoning_mode: reasoningMode,
          assumptions,
          clarification_questions: clarificationQuestions,
          readiness: readiness.level,
          readiness_reason: readiness.reason,
          llm_touchpoints: llmTouchpoints,
          recommended_next_step:
            missingInputs.length > 0 ? 'clarify_missing_inputs' : 'build_resolution_plan',
        },
      };
    }
    case 'execution_brief_to_operator_packet': {
      const brief = ctx[params.from || 'execution_brief'];
      if (!brief || typeof brief !== 'object')
        throw new Error('execution_brief_to_operator_packet requires actuator-execution-brief');
      const missingInputs = Array.isArray(brief.missing_inputs) ? brief.missing_inputs : [];
      const reasoningMode: 'placeholder' | 'model' =
        brief.reasoning_mode || (missingInputs.length > 0 ? 'placeholder' : 'model');
      const nextActions =
        missingInputs.length > 0
          ? [
              {
                id: 'answer-clarifications',
                priority: 'now',
                next_action_type: 'clarify',
                action: 'Answer the clarification questions',
                reason: 'The request still has blocking ambiguity.',
                suggested_followup_request: `Please provide the following missing inputs: ${missingInputs.join(', ')}`,
              },
            ]
          : [
              {
                id: 'review-plan',
                priority: 'next',
                next_action_type: 'execute_now',
                action: 'Review the execution preview and start execution',
                reason: 'The request is sufficiently structured.',
                suggested_followup_request: 'Please proceed with this plan.',
              },
            ];
      return {
        ...ctx,
        [params.export_as || 'operator_packet']: {
          kind: 'operator-interaction-packet',
          interaction_type: missingInputs.length > 0 ? 'clarification' : 'execution-preview',
          headline:
            missingInputs.length > 0 ? 'Additional input required' : 'Execution preview is ready',
          summary: brief.user_facing_summary || brief.summary || '',
          readiness: brief.readiness || 'needs_clarification',
          confidence: brief.confidence || 0,
          reasoning_mode: reasoningMode,
          questions: brief.clarification_questions || [],
          next_actions: nextActions,
          suggested_response_style:
            missingInputs.length > 0 ? 'clarify-first' : 'preview-and-confirm',
          llm_touchpoints: brief.llm_touchpoints || [],
        },
      };
    }
    case 'request_to_status_brief': {
      const requestText = String(
        resolveVars(params.request_text || ctx.request_text || '', ctx)
      ).trim();
      if (!requestText) throw new Error('request_to_status_brief requires request_text');
      const lowered = requestText.toLowerCase();
      const targetMissionId = requestText.match(/MSN-[A-Z0-9-]+/i)?.[0] || null;
      const targetProjectId = requestText.match(/PRJ-[A-Z0-9-]+/i)?.[0] || null;
      const scope =
        targetMissionId || lowered.includes('mission') || lowered.includes('ミッション')
          ? 'missions'
          : targetProjectId || lowered.includes('project') || lowered.includes('プロジェクト')
            ? 'projects'
            : lowered.includes('actuator') || lowered.includes('アクチュエータ')
              ? 'actuators'
              : lowered.includes('surface') ||
                  lowered.includes('サービス') ||
                  lowered.includes('稼働')
                ? 'surfaces'
                : 'system';
      const focusAreas = scope === 'system' ? ['surfaces', 'catalogs', 'esm-integrity'] : [scope];
      return {
        ...ctx,
        [params.export_as || 'status_brief']: {
          kind: 'system-status-brief',
          request_text: requestText,
          scope,
          focus_areas: focusAreas,
          target_mission_id: targetMissionId,
          target_project_id: targetProjectId,
          recommended_sources: [
            'dist/scripts/surface_runtime.js --action status',
            'pnpm run check -- --scope pr --only esm',
            'pnpm run check -- --scope full --only catalogs',
          ],
        },
      };
    }
    case 'execution_brief_to_resolution_plan': {
      const brief = ctx[params.from || 'execution_brief'];
      if (!brief || typeof brief !== 'object')
        throw new Error('execution_brief_to_resolution_plan requires actuator-execution-brief');
      const reasoningMode: 'placeholder' | 'model' =
        brief.reasoning_mode ||
        (Array.isArray(brief.missing_inputs) && brief.missing_inputs.length > 0
          ? 'placeholder'
          : 'model');
      const phases = [
        {
          id: 'normalize',
          title: 'Normalize request into governed execution scope',
          actuators: ['orchestrator-actuator', 'modeling-actuator'],
          artifacts: ['execution brief'],
          exit_criteria: ['request scope is explicit', 'missing inputs are listed'],
        },
        {
          id: 'produce',
          title: 'Generate requested deliverables through target actuators',
          actuators: Array.isArray(brief.target_actuators) ? brief.target_actuators : [],
          artifacts: Array.isArray(brief.deliverables) ? brief.deliverables : [],
          exit_criteria: ['deliverables are generated in governed paths'],
        },
        {
          id: 'validate',
          title: 'Validate outputs and produce evidence pack',
          actuators: ['artifact-actuator', 'media-actuator'],
          artifacts: ['evidence pack'],
          exit_criteria: ['results are reviewable', 'traceability is preserved'],
        },
      ];
      return {
        ...ctx,
        [params.export_as || 'resolution_plan']: {
          kind: 'actuator-resolution-plan',
          archetype_id: brief.archetype_id,
          summary: brief.summary,
          reasoning_mode: reasoningMode,
          phases,
        },
      };
    }
    case 'collect_system_status_snapshot': {
      const brief = ctx[params.from || 'status_brief'];
      if (!brief || typeof brief !== 'object')
        throw new Error('collect_system_status_snapshot requires system-status-brief');
      const surfaceStatus = parseJsonCommandOutput(
        safeExec('node', ['dist/scripts/surface_runtime.js', '--action', 'status'], {
          cwd: pathResolver.rootDir(),
          timeoutMs: 120000,
        })
      );
      const esmIntegrity = collectCommandHealth('pnpm', [
        'run',
        'check',
        '--',
        '--scope',
        'pr',
        '--only',
        'esm',
      ]);
      const catalogIntegrity = collectCommandHealth('pnpm', [
        'run',
        'check',
        '--',
        '--scope',
        'full',
        '--only',
        'catalogs',
      ]);
      const missionStatus =
        brief.scope === 'missions' || brief.scope === 'system'
          ? collectMissionStatusSnapshot(
              brief.target_mission_id || brief.target_project_id || undefined
            )
          : undefined;
      const projectStatus =
        brief.scope === 'projects' || brief.scope === 'system'
          ? collectProjectStatusSnapshot(brief.target_project_id || undefined)
          : undefined;
      return {
        ...ctx,
        [params.export_as || 'system_status_snapshot']: {
          kind: 'system-status-snapshot',
          scope: brief.scope,
          captured_at: nowIso(),
          surface_status: surfaceStatus,
          esm_integrity: esmIntegrity,
          catalog_integrity: catalogIntegrity,
          mission_status: missionStatus,
          project_status: projectStatus,
        },
      };
    }
    case 'status_snapshot_to_report': {
      const snapshot = ctx[params.from || 'system_status_snapshot'];
      if (!snapshot || typeof snapshot !== 'object')
        throw new Error('status_snapshot_to_report requires system_status_snapshot');
      const health = snapshot.surface_status?.health || {};
      const healthEntries = Object.entries(
        health as Record<string, { status?: string; detail?: string }>
      );
      const unhealthy = healthEntries.filter(([, value]) => value?.status === 'unhealthy');
      const unknown = healthEntries.filter(([, value]) => value?.status === 'unknown');
      const findings = [
        ...unhealthy.map(([id, value]) => ({
          id: `surface-${id}`,
          severity: 'error',
          message: `${id} is unhealthy`,
          detail: String(value?.detail || 'unhealthy'),
        })),
        ...unknown.map(([id, value]) => ({
          id: `surface-${id}-unknown`,
          severity: 'warning',
          message: `${id} health is unknown`,
          detail: String(value?.detail || 'unknown'),
        })),
      ];
      if (!snapshot.esm_integrity?.ok) {
        findings.push({
          id: 'esm-integrity',
          severity: 'error',
          message: 'ESM integrity check failed',
          detail: String(snapshot.esm_integrity?.detail || 'unknown failure'),
        });
      }
      if (!snapshot.catalog_integrity?.ok) {
        findings.push({
          id: 'catalog-integrity',
          severity: 'error',
          message: 'Catalog integrity check failed',
          detail: String(snapshot.catalog_integrity?.detail || 'unknown failure'),
        });
      }
      const missionMetrics = snapshot.mission_status?.metrics || {};
      const projectMetrics = snapshot.project_status?.metrics || {};
      if ((missionMetrics.active || 0) > 0) {
        findings.push({
          id: 'active-missions',
          severity: 'info',
          message: `${missionMetrics.active} active mission(s)`,
          detail: `completed=${missionMetrics.completed || 0}, total=${missionMetrics.total || 0}`,
        });
      }
      if ((projectMetrics.project_count || 0) > 0) {
        findings.push({
          id: 'tracked-projects',
          severity: 'info',
          message: `${projectMetrics.project_count} tracked project(s)`,
          detail: `linked missions=${projectMetrics.linked_missions || 0}`,
        });
      }
      if (snapshot.mission_status?.target) {
        findings.push({
          id: 'target-mission',
          severity: 'info',
          message: `Target mission ${snapshot.mission_status.target.mission_id} is ${snapshot.mission_status.target.status}`,
          detail: `tier=${snapshot.mission_status.target.tier}, project=${snapshot.mission_status.target.project_id || 'none'}`,
        });
      }
      if (snapshot.project_status?.target) {
        findings.push({
          id: 'target-project',
          severity: 'info',
          message: `Target project ${snapshot.project_status.target.project_name}`,
          detail: `linked missions=${snapshot.project_status.target.linked_missions || 0}, active=${snapshot.project_status.target.active_missions || 0}`,
        });
      }
      // OP-01 Task 2.3: surface this week's LLM cost in the operator packet.
      // Cost visibility must never break status reporting, so failures are
      // swallowed and simply omit the finding.
      let weeklyCostUsd: number | undefined;
      try {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const costReport = buildCostReportFromHistory({ since: weekAgo });
        if (costReport.calls > 0) {
          weeklyCostUsd = Math.round(costReport.total_usd * 100) / 100;
          const topMissions = costReport.by_mission
            .slice(0, 3)
            .map((bucket: any) => `${bucket.key}: $${bucket.cost_usd.toFixed(2)}`)
            .join(', ');
          findings.push({
            id: 'weekly-cost',
            severity: 'info',
            message: `This week's LLM cost: $${weeklyCostUsd.toFixed(2)} (${costReport.calls} calls)`,
            detail:
              `top missions — ${topMissions || '(none)'}` +
              (costReport.estimated_usd > 0
                ? `; estimated portion $${costReport.estimated_usd.toFixed(2)}`
                : ''),
          });
        }
      } catch (_) {
        /* no cost ledger yet — omit the finding */
      }
      // LC-09 follow-up: weekly llm_decide degradation count — a pipeline
      // fleet quietly riding deterministic fallbacks should be visible here.
      let weeklyDegradations: number | undefined;
      try {
        const degradation = summarizeSemanticDegradations({
          sinceMs: 7 * 24 * 60 * 60 * 1000,
        });
        if (degradation.total > 0) {
          weeklyDegradations = degradation.total;
          const reasons = Object.entries(degradation.by_reason)
            .map(([reason, count]) => `${reason}=${count}`)
            .join(', ');
          const pipelines = degradation.top_pipelines
            .map((entry) => `${entry.pipeline_id} (${entry.total})`)
            .join(', ');
          findings.push({
            id: 'semantic-degradations',
            severity: 'warn',
            message: `llm_decide degraded ${degradation.total}x across ${degradation.runs} run(s) this week (${reasons})`,
            detail: `top pipelines — ${pipelines || '(none)'}`,
          });
        }
      } catch (_) {
        /* no degradation log yet — omit the finding */
      }
      // LC-02 follow-up: ad-hoc ADFs that keep succeeding are promotion
      // candidates — surface them instead of waiting for someone to notice.
      try {
        const candidates = listPromotionCandidates();
        if (candidates.length > 0) {
          const listed = candidates
            .slice(0, 3)
            .map((entry) => `${entry.path} (${entry.count}x)`)
            .join(', ');
          findings.push({
            id: 'promotion-candidates',
            severity: 'info',
            message: `${candidates.length} ad-hoc pipeline(s) succeeded repeatedly — promote with pipeline:promote`,
            detail: listed,
          });
        }
      } catch (_) {
        /* no tally yet — omit the finding */
      }
      const surfaceCount = Object.keys(snapshot.surface_status?.surfaces || {}).length;
      const headline = findings.some((item) => item.severity === 'error')
        ? 'System requires attention'
        : findings.length > 0
          ? 'System is partially healthy'
          : 'System is healthy';
      const summary = `Scope=${snapshot.scope}; surfaces=${surfaceCount}; unhealthy=${unhealthy.length}; unknown=${unknown.length}; missions=${missionMetrics.total || 0}; projects=${projectMetrics.project_count || 0}; esm=${snapshot.esm_integrity?.ok ? 'ok' : 'failed'}; catalogs=${snapshot.catalog_integrity?.ok ? 'ok' : 'failed'}`;
      const nextActions = deriveStatusNextActions(snapshot, findings);
      return {
        ...ctx,
        [params.export_as || 'system_status_report']: {
          kind: 'system-status-report',
          scope: String(snapshot.scope || 'system'),
          headline,
          summary,
          findings,
          next_actions: nextActions,
          metrics: {
            surface_count: surfaceCount,
            unhealthy_surfaces: unhealthy.length,
            unknown_surfaces: unknown.length,
            mission_total: missionMetrics.total || 0,
            mission_active: missionMetrics.active || 0,
            project_count: projectMetrics.project_count || 0,
            linked_missions: projectMetrics.linked_missions || 0,
            esm_ok: Boolean(snapshot.esm_integrity?.ok),
            catalogs_ok: Boolean(snapshot.catalog_integrity?.ok),
            ...(weeklyCostUsd !== undefined ? { weekly_cost_usd: weeklyCostUsd } : {}),
            ...(weeklyDegradations !== undefined
              ? { weekly_semantic_degradations: weeklyDegradations }
              : {}),
          },
          sources: [
            'dist/scripts/surface_runtime.js --action status',
            'pnpm run check -- --scope pr --only esm',
            'pnpm run check -- --scope full --only catalogs',
          ],
        },
      };
    }
    case 'status_report_to_operator_packet': {
      const report = ctx[params.from || 'system_status_report'];
      if (!report || typeof report !== 'object')
        throw new Error('status_report_to_operator_packet requires system-status-report');
      return {
        ...ctx,
        [params.export_as || 'operator_packet']: {
          kind: 'operator-interaction-packet',
          interaction_type: 'status-summary',
          headline: String(report.headline || 'Status summary'),
          summary: String(report.summary || ''),
          readiness: 'status_ready',
          confidence: 5,
          next_actions: Array.isArray(report.next_actions) ? report.next_actions : [],
          suggested_response_style: 'status-summary',
          refresh_command:
            'node dist/libs/actuators/orchestrator-actuator/src/index.js --input libs/actuators/orchestrator-actuator/examples/request-to-status-operator-packet.json',
          refresh_packet_path:
            'active/shared/tmp/orchestrator/status-operator-interaction-packet.json',
          llm_touchpoints: [
            {
              stage: 'status-collection',
              purpose: 'Collect governed runtime and traceability signals before answering.',
              output_contract: 'system-status-report',
            },
            {
              stage: 'status-explanation',
              purpose:
                'Summarize current state and recommend next actions in human-facing language.',
              output_contract: 'operator-interaction-packet',
            },
          ],
        },
      };
    }
    case 'operator_packet_to_response_preview': {
      const packet = ctx[params.from || 'operator_packet'];
      if (!packet || typeof packet !== 'object')
        throw new Error('operator_packet_to_response_preview requires operator-interaction-packet');
      const reasoningMode: 'placeholder' | 'model' = packet.reasoning_mode || 'model';
      const lines: string[] = [];
      lines.push(String(packet.headline || ''));
      if (packet.summary) lines.push(String(packet.summary));
      lines.push(`Reasoning mode: ${reasoningMode}`);
      if (packet.readiness) lines.push(`Readiness: ${String(packet.readiness)}`);
      if (typeof packet.confidence === 'number')
        lines.push(`Confidence: ${String(packet.confidence)}`);
      if (Array.isArray(packet.questions) && packet.questions.length > 0) {
        lines.push('');
        lines.push('Questions:');
        for (const question of packet.questions) {
          lines.push(`- ${String(question.question || question.id || 'Question required')}`);
          if (question.reason) lines.push(`  reason: ${String(question.reason)}`);
        }
      }
      if (Array.isArray(packet.next_actions) && packet.next_actions.length > 0) {
        lines.push('');
        lines.push('Next actions:');
        for (const action of packet.next_actions) {
          lines.push(`- ${String(action.action || action.id || 'Action')}`);
          if (action.reason) lines.push(`  reason: ${String(action.reason)}`);
          if (action.suggested_followup_request)
            lines.push(`  follow-up: ${String(action.suggested_followup_request)}`);
        }
      }
      return {
        ...ctx,
        [params.export_as || 'response_preview']: {
          kind: 'operator-response-preview',
          format: 'plain-text',
          reasoning_mode: reasoningMode,
          text: lines.join('\n').trim(),
        },
      };
    }
    case 'delivery_pack_to_operator_packet': {
      const pack = ctx[params.from || 'delivery_pack'];
      if (!pack || typeof pack !== 'object')
        throw new Error('delivery_pack_to_operator_packet requires delivery-pack');
      const artifacts = Array.isArray(pack.artifacts) ? pack.artifacts : [];
      const mainArtifactId = String(pack.main_artifact_id || artifacts[0]?.id || '');
      const mainArtifact =
        artifacts.find((artifact: any) => artifact?.id === mainArtifactId) || artifacts[0] || null;
      const nextActions = [];
      if (mainArtifact?.path) {
        const mainArtifactPath = String(mainArtifact.path);
        const mainArtifactExt = path.extname(mainArtifactPath).toLowerCase();
        const isLikelyBinaryArtifact = ![
          '.json',
          '.md',
          '.txt',
          '.log',
          '.xml',
          '.yaml',
          '.yml',
        ].includes(mainArtifactExt);
        nextActions.push({
          id: 'review-main-artifact',
          priority: 'now',
          action: `Review main artifact ${String(mainArtifact.id || 'artifact')}`,
          reason: 'Primary deliverable is ready for review.',
          suggested_command: `pnpm kyberion artifact ${mainArtifactPath}`,
          suggested_followup_request: `Please review the main deliverable ${String(mainArtifact.id || 'artifact')}.`,
        });
        if (isLikelyBinaryArtifact) {
          nextActions.push({
            id: 'open-main-artifact',
            priority: 'next',
            action: `Open main artifact ${String(mainArtifact.id || 'artifact')}`,
            reason:
              'The primary deliverable is a binary artifact and may be easier to review in a local viewer.',
            suggested_command: `pnpm kyberion open-artifact ${mainArtifactPath}`,
            suggested_followup_request: `Please open the main deliverable ${String(mainArtifact.id || 'artifact')} in a local viewer.`,
          });
        }
      }
      if (
        Array.isArray(pack.artifacts_by_role?.evidence) &&
        pack.artifacts_by_role.evidence.length > 0
      ) {
        const evidenceArtifactId = String(pack.artifacts_by_role.evidence[0] || '');
        const evidenceArtifact =
          artifacts.find((artifact: any) => artifact?.id === evidenceArtifactId) || null;
        nextActions.push({
          id: 'review-evidence',
          priority: 'next',
          action: 'Review evidence and validation artifacts',
          reason: 'Evidence artifacts are available in the delivery pack.',
          ...(evidenceArtifact?.path
            ? {
                suggested_command: `pnpm kyberion artifact ${String(evidenceArtifact.path)}`,
              }
            : {}),
          suggested_followup_request: 'Please review the evidence and validation artifacts.',
        });
      }
      return {
        ...ctx,
        [params.export_as || 'operator_packet']: {
          kind: 'operator-interaction-packet',
          interaction_type: 'delivery-summary',
          headline: 'Delivery pack is ready',
          summary: String(pack.summary || 'Delivery artifacts are ready for review.'),
          readiness: 'delivery_ready',
          confidence: 5,
          next_actions: nextActions,
          suggested_response_style: 'preview-and-confirm',
          llm_touchpoints: [
            {
              stage: 'delivery-packaging',
              purpose: 'Summarize governed deliverables and traceable artifacts for human review.',
              output_contract: 'delivery-pack',
            },
            {
              stage: 'delivery-explanation',
              purpose: 'Explain what was produced and what should be reviewed next.',
              output_contract: 'operator-interaction-packet',
            },
          ],
        },
      };
    }
    case 'resolution_plan_to_pipeline_bundle': {
      const plan = ctx[params.from || 'resolution_plan'];
      const brief = resolveExecutionBriefReference(ctx, params.brief_from) as
        Record<string, unknown> | undefined;
      if (!plan || typeof plan !== 'object')
        throw new Error('resolution_plan_to_pipeline_bundle requires actuator-resolution-plan');
      if (!brief || typeof brief !== 'object') {
        throw new Error(
          'resolution_plan_to_pipeline_bundle requires actuator-execution-brief. Provide params.brief_from or export the brief as "execution_brief" or "brief".'
        );
      }
      const missingInputs = Array.isArray(brief.missing_inputs)
        ? brief.missing_inputs.map(String)
        : [];
      const jobs =
        missingInputs.length === 0
          ? buildPipelineBundleJobs(String(plan.archetype_id || 'structured-delivery'))
          : [];
      return {
        ...ctx,
        [params.export_as || 'pipeline_bundle']: {
          kind: 'actuator-pipeline-bundle',
          archetype_id: String(plan.archetype_id || brief.archetype_id || 'structured-delivery'),
          status: missingInputs.length === 0 ? 'ready' : 'clarification_required',
          summary: brief.summary || plan.summary || 'Actuator execution pipeline bundle',
          missing_inputs: missingInputs,
          jobs,
        },
      };
    }
    case 'pipeline_bundle_to_execution_plan_set': {
      const bundle = ctx[params.from || 'pipeline_bundle'];
      if (!bundle || typeof bundle !== 'object')
        throw new Error('pipeline_bundle_to_execution_plan_set requires actuator-pipeline-bundle');
      const variables =
        typeof params.variables === 'object' && params.variables !== null ? params.variables : {};
      const outputDir = String(
        params.output_dir ||
          `active/shared/runtime/generated-pipelines/${bundle.archetype_id || 'bundle'}`
      );
      const jobs = Array.isArray(bundle.jobs)
        ? bundle.jobs.map((job: PipelineBundleJob) =>
            renderPipelineBundleJob(job, variables, outputDir)
          )
        : [];
      return {
        ...ctx,
        [params.export_as || 'execution_plan_set']: {
          kind: 'actuator-execution-plan-set',
          archetype_id: String(bundle.archetype_id || 'structured-delivery'),
          status: String(bundle.status || 'ready'),
          output_dir: outputDir,
          missing_inputs: Array.isArray(bundle.missing_inputs) ? bundle.missing_inputs : [],
          jobs,
        },
      };
    }
    case 'run_execution_plan_set': {
      const planSet = ctx[params.from || 'execution_plan_set'];
      if (!planSet || typeof planSet !== 'object')
        throw new Error('run_execution_plan_set requires execution_plan_set');
      const { planSet: validatedPlanSet, report } = preflightExecutionPlanSet(planSet);
      const runReport =
        report.status === 'invalid'
          ? {
              kind: 'actuator-execution-run-report',
              status: 'failed',
              total_jobs: 0,
              preflight_report: report,
              results: [],
            }
          : executeExecutionPlanSet(validatedPlanSet, report);
      return {
        ...ctx,
        execution_plan_preflight: report,
        validated_execution_plan_set: validatedPlanSet,
        [params.export_as || 'execution_run_report']: runReport,
      };
    }
    case 'execute_task_plan': {
      const missionId = String(resolveVars(params.mission_id || ctx.mission_id || '', ctx));
      if (!missionId) throw new Error('execute_task_plan requires mission_id');
      const result = await executeTaskPlanFromOrchestrator({
        missionId,
        maxTasks: typeof params.max_tasks === 'number' ? params.max_tasks : undefined,
        haltOnFailure: Boolean(params.halt_on_failure),
        model: params.model ? String(resolveVars(params.model, ctx)) : undefined,
        cwd: params.cwd ? String(resolveVars(params.cwd, ctx)) : undefined,
      });
      return {
        ...ctx,
        [params.export_as || 'task_execution_report']: result,
      };
    }
    case 'preflight_execution_plan_set': {
      const planSet = ctx[params.from || 'execution_plan_set'];
      if (!planSet || typeof planSet !== 'object')
        throw new Error('preflight_execution_plan_set requires execution_plan_set');
      const { planSet: validatedPlanSet, report } = preflightExecutionPlanSet(planSet);
      return {
        ...ctx,
        validated_execution_plan_set: validatedPlanSet,
        [params.export_as || 'execution_plan_preflight']: report,
      };
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

async function opApply(op: string, params: any, ctx: any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'write_file':
      const out = resolveOrchestratorRepositoryPath(rootDir, resolveVars(params.path, ctx));
      const content = params.from ? ctx[params.from] : (ctx.last_transform ?? ctx.last_capture);
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      await retry(async () => {
        safeWriteFile(
          out,
          typeof content === 'string' ? content : JSON.stringify(content, null, 2)
        );
      }, buildRetryOptions(params.retry));
      break;
    case 'mkdir':
      safeMkdir(resolveOrchestratorRepositoryPath(rootDir, resolveVars(params.path, ctx)), {
        recursive: true,
      });
      break;
    case 'symlink':
      const target = resolveOrchestratorRepositoryPath(rootDir, resolveVars(params.target, ctx));
      const source = resolveOrchestratorRepositoryPath(rootDir, resolveVars(params.source, ctx));
      if (safeExistsSync(target)) safeUnlinkSync(target);
      if (!safeExistsSync(path.dirname(target)))
        safeMkdir(path.dirname(target), { recursive: true });
      safeSymlinkSync(source, target, params.type || 'dir');
      break;
    case 'git_checkpoint':
      await retry(
        async () => {
          safeExec('git', ['add', '.'], { cwd: rootDir });
          safeExec('git', ['commit', '-m', resolveVars(params.message || 'checkpoint', ctx)], {
            cwd: rootDir,
          });
        },
        buildRetryOptions({ maxRetries: 2, initialDelayMs: 1000 })
      );
      break;
    case 'log':
      logger.info(`[ORCH_LOG] ${resolveVars(params.message || 'Action completed', ctx)}`);
      break;
    case 'decompose_into_tasks': {
      const result = await decomposeIntoTasks({
        mission_id: String(resolveVars(params.mission_id || ctx.mission_id || '', ctx)),
        project_name: String(resolveVars(params.project_name || ctx.project_name || '', ctx)),
        requirements_draft_path: params.requirements_draft_path
          ? String(resolveVars(params.requirements_draft_path, ctx))
          : undefined,
        design_spec_path: params.design_spec_path
          ? String(resolveVars(params.design_spec_path, ctx))
          : undefined,
      });
      return { ...ctx, [params.export_as || 'task_plan_result']: result };
    }
    case 'evaluate_task_plan_ready':
      return {
        ...ctx,
        [params.export_as || 'task_plan_ready']: evaluateTaskPlanReadyGate(
          String(resolveVars(params.mission_id || ctx.mission_id || '', ctx))
        ),
      };
    case 'task_plan_to_next_tasks': {
      const result = taskPlanToNextTasks({
        mission_id: String(resolveVars(params.mission_id || ctx.mission_id || '', ctx)),
      });
      return { ...ctx, [params.export_as || 'next_tasks_result']: result };
    }
    case 'write_execution_plan_set': {
      const planSet =
        ctx[params.from || 'validated_execution_plan_set'] ||
        ctx[params.from || 'execution_plan_set'];
      if (!planSet || typeof planSet !== 'object')
        throw new Error('write_execution_plan_set requires execution_plan_set');
      const { planSet: validatedPlanSet, report } = preflightExecutionPlanSet(planSet);
      if (report.status === 'invalid') {
        throw new Error(
          `write_execution_plan_set blocked by preflight: ${report.issues.map((issue) => issue.message).join('; ')}`
        );
      }
      for (const job of Array.isArray(validatedPlanSet.jobs) ? validatedPlanSet.jobs : []) {
        if (!job?.output_path || !job?.rendered_pipeline || job.skipped_reason) continue;
        const requestedOutputPath = String(job.output_path);
        const guardedOutputPath = resolveOrchestratorRepositoryPath(rootDir, requestedOutputPath);
        const logicalOutputDir = path.dirname(guardedOutputPath);
        if (!safeExistsSync(logicalOutputDir)) safeMkdir(logicalOutputDir, { recursive: true });
        safeWriteFile(requestedOutputPath, JSON.stringify(job.rendered_pipeline, null, 2));
      }
      break;
    }
    default:
      throw buildUnknownOrchestratorOpError(op);
  }
  return ctx;
}

export {
  loadActuatorRequestArchetypes,
  detectRequestArchetype,
  normalizeRequestTextForArchetypeDetection,
  EXECUTION_BRIEF_INPUT_ALIASES,
  resolveExecutionBriefInputs,
  normalizeExecutionBriefInputName,
  inferExecutionBriefInputBinding,
  lookupAliasValue,
  isMeaningfulInputValue,
  previewExecutionBriefInputValue,
  resolveExecutionBriefReference,
  buildPipelineBundleJobs,
  renderPipelineBundleJob,
  normalizeOutputPath,
  repairRenderedPipelineContract,
  validateRenderedPipelineContract,
  preflightExecutionPlanSet,
  executeExecutionPlanSet,
  collectCommandHealth,
  parseJsonCommandOutput,
  buildClarificationQuestion,
  deriveExecutionBriefReadiness,
  deriveStatusNextActions,
  collectMissionStatusSnapshot,
  collectProjectStatusSnapshot,
  resolveActuatorEntryPath,
  applyPathOverrides,
  renderTemplateValue,
  renderTemplateString,
  setByPath,
} from './orchestrator-execution-brief-helpers.js';
