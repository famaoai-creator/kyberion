import { logger, safeReadFile, safeWriteFile, safeExec, safeMkdir, safeExistsSync, safeUnlinkSync, safeSymlinkSync, resolveVars, evaluateCondition, withRetry, derivePipelineStatus } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';

/**
 * Orchestrator-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Unified ADF-driven engine for Mission & Task Management with Control Flow.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

type PipelineBundleJob = {
  id: string;
  title: string;
  actuator: string;
  template_path: string;
  recommended_procedure?: string;
  parameter_overrides?: Record<string, unknown>;
  outputs?: string[];
};

type ExecutionPlanSetJob = PipelineBundleJob & {
  output_path?: string;
  rendered_pipeline?: Record<string, unknown>;
  skipped_reason?: string;
};

type ExecutionPlanRunResult = {
  id: string;
  actuator: string;
  input_path?: string;
  status: 'succeeded' | 'failed' | 'skipped';
  skipped_reason?: string;
  output?: unknown;
  error?: string;
};

interface OrchestratorAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

const ACTUATOR_ARCHETYPES_PATH = path.join(process.cwd(), 'knowledge/public/orchestration/actuator-request-archetypes.json');

/**
 * Main Entry Point
 */
async function handleAction(input: OrchestratorAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = process.cwd();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, root: rootDir, HOME: process.env.HOME || '/Users' };
  
  if (initialCtx.context_path && safeExistsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = JSON.parse(safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string);
    ctx = { ...ctx, ...saved };
  }

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Execution timed out (${TIMEOUT}ms)`);

    try {
      logger.info(`  [ORCH_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      
      if (step.type === 'control') {
        ctx = await opControl(step.op, step.params, ctx, options, state);
      } else {
        switch (step.type) {
          case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
          case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
          case 'apply': await opApply(step.op, step.params, ctx); break;
        }
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [ORCH_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
}

/**
 * CONTROL Operators
 */
async function opControl(op: string, params: any, ctx: any, options: any, state: any) {
  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executePipeline(params.then, ctx, options, state);
        return res.context;
      } else if (params.else) {
        const res = await executePipeline(params.else, ctx, options, state);
        return res.context;
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        const res = await executePipeline(params.pipeline, ctx, options, state);
        ctx = res.context;
        iterations++;
      }
      return ctx;

    default: return ctx;
  }
}

/**
 * CAPTURE Operators
 */
async function opCapture(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  switch (op) {
    case 'read_json':
      return { ...ctx, [params.export_as || 'last_capture_data']: JSON.parse(safeReadFile(path.resolve(rootDir, resolveVars(params.path, ctx)), { encoding: 'utf8' }) as string) };
    case 'read_file':
      return { ...ctx, [params.export_as || 'last_capture']: safeReadFile(path.resolve(rootDir, resolveVars(params.path, ctx)), { encoding: 'utf8' }) };
    case 'shell':
      const cmd = resolveVars(params.cmd, ctx);
      const shellResult = await withRetry(async () => safeExec(cmd), params.retry || { maxRetries: 2 });
      return { ...ctx, [params.export_as || 'last_capture']: shellResult.trim() };
    case 'intent_detect':
      const mapping = yaml.load(safeReadFile(path.resolve(rootDir, resolveVars(params.mapping_path, ctx)), { encoding: 'utf8' }) as string) as any;
      const query = resolveVars(params.query, ctx).toLowerCase();
      const detected = mapping.intents.find((i: any) => i.trigger_phrases.some((p: string) => query.includes(p.toLowerCase())));
      return { ...ctx, [params.export_as || 'detected_intent']: detected };
    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any) {
  switch (op) {
    case 'json_query':
      const data = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: result };
    case 'variable_hydrate':
      const input = typeof ctx[params.from] === 'object' ? JSON.stringify(ctx[params.from]) : String(ctx[params.from]);
      const hydrated = resolveVars(input, ctx);
      return { ...ctx, [params.export_as || 'last_transform']: params.is_json ? JSON.parse(hydrated) : hydrated };
    case 'request_to_execution_brief': {
      const catalog = loadActuatorRequestArchetypes();
      const requestText = String(resolveVars(params.request_text || ctx.request_text || '', ctx)).trim();
      if (!requestText) throw new Error('request_to_execution_brief requires request_text');
      const archetype = detectRequestArchetype(requestText, catalog);
      const providedInputs = Array.isArray(params.provided_inputs) ? params.provided_inputs.map(String) : [];
      const missingInputs = (archetype.required_inputs || []).filter((item: string) => !providedInputs.includes(item));
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
          assumptions,
          clarification_questions: clarificationQuestions,
          readiness: readiness.level,
          readiness_reason: readiness.reason,
          llm_touchpoints: llmTouchpoints,
          recommended_next_step: missingInputs.length > 0 ? 'clarify_missing_inputs' : 'build_resolution_plan',
        },
      };
    }
    case 'execution_brief_to_operator_packet': {
      const brief = ctx[params.from || 'execution_brief'];
      if (!brief || typeof brief !== 'object') throw new Error('execution_brief_to_operator_packet requires actuator-execution-brief');
      const missingInputs = Array.isArray(brief.missing_inputs) ? brief.missing_inputs : [];
      const nextActions = missingInputs.length > 0
        ? [{
            id: 'answer-clarifications',
            priority: 'now',
            next_action_type: 'clarify',
            action: 'Answer the clarification questions',
            reason: 'The request still has blocking ambiguity.',
            suggested_followup_request: `Please provide the following missing inputs: ${missingInputs.join(', ')}`,
          }]
        : [{
            id: 'review-plan',
            priority: 'next',
            next_action_type: 'execute_now',
            action: 'Review the execution preview and start execution',
            reason: 'The request is sufficiently structured.',
            suggested_followup_request: 'Please proceed with this plan.',
          }];
      return {
        ...ctx,
        [params.export_as || 'operator_packet']: {
          kind: 'operator-interaction-packet',
          interaction_type: missingInputs.length > 0 ? 'clarification' : 'execution-preview',
          headline: missingInputs.length > 0 ? 'Additional input required' : 'Execution preview is ready',
          summary: brief.user_facing_summary || brief.summary || '',
          readiness: brief.readiness || 'needs_clarification',
          confidence: brief.confidence || 0,
          questions: brief.clarification_questions || [],
          next_actions: nextActions,
          suggested_response_style: missingInputs.length > 0 ? 'clarify-first' : 'preview-and-confirm',
          llm_touchpoints: brief.llm_touchpoints || [],
        },
      };
    }
    case 'request_to_status_brief': {
      const requestText = String(resolveVars(params.request_text || ctx.request_text || '', ctx)).trim();
      if (!requestText) throw new Error('request_to_status_brief requires request_text');
      const lowered = requestText.toLowerCase();
      const targetMissionId = requestText.match(/MSN-[A-Z0-9-]+/i)?.[0] || null;
      const targetProjectId = requestText.match(/PRJ-[A-Z0-9-]+/i)?.[0] || null;
      const scope =
        targetMissionId || lowered.includes('mission') || lowered.includes('ミッション') ? 'missions' :
        targetProjectId || lowered.includes('project') || lowered.includes('プロジェクト') ? 'projects' :
        lowered.includes('actuator') || lowered.includes('アクチュエータ') ? 'actuators' :
        lowered.includes('surface') || lowered.includes('サービス') || lowered.includes('稼働') ? 'surfaces' :
        'system';
      const focusAreas = scope === 'system'
        ? ['surfaces', 'catalogs', 'esm-integrity']
        : [scope];
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
            'pnpm run check:esm',
            'pnpm run check:catalogs',
          ],
        },
      };
    }
    case 'execution_brief_to_resolution_plan': {
      const brief = ctx[params.from || 'execution_brief'];
      if (!brief || typeof brief !== 'object') throw new Error('execution_brief_to_resolution_plan requires actuator-execution-brief');
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
          phases,
        },
      };
    }
    case 'collect_system_status_snapshot': {
      const brief = ctx[params.from || 'status_brief'];
      if (!brief || typeof brief !== 'object') throw new Error('collect_system_status_snapshot requires system-status-brief');
      const surfaceStatus = parseJsonCommandOutput(safeExec('node', ['dist/scripts/surface_runtime.js', '--action', 'status'], {
        cwd: process.cwd(),
        timeoutMs: 120000,
      }));
      const esmIntegrity = collectCommandHealth('pnpm', ['run', 'check:esm']);
      const catalogIntegrity = collectCommandHealth('pnpm', ['run', 'check:catalogs']);
      const missionStatus = brief.scope === 'missions' || brief.scope === 'system'
        ? collectMissionStatusSnapshot(brief.target_mission_id || brief.target_project_id || undefined)
        : undefined;
      const projectStatus = brief.scope === 'projects' || brief.scope === 'system'
        ? collectProjectStatusSnapshot(brief.target_project_id || undefined)
        : undefined;
      return {
        ...ctx,
        [params.export_as || 'system_status_snapshot']: {
          kind: 'system-status-snapshot',
          scope: brief.scope,
          captured_at: new Date().toISOString(),
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
      if (!snapshot || typeof snapshot !== 'object') throw new Error('status_snapshot_to_report requires system_status_snapshot');
      const health = snapshot.surface_status?.health || {};
      const healthEntries = Object.entries(health as Record<string, { status?: string; detail?: string }>);
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
          },
          sources: [
            'dist/scripts/surface_runtime.js --action status',
            'pnpm run check:esm',
            'pnpm run check:catalogs',
          ],
        },
      };
    }
    case 'status_report_to_operator_packet': {
      const report = ctx[params.from || 'system_status_report'];
      if (!report || typeof report !== 'object') throw new Error('status_report_to_operator_packet requires system-status-report');
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
          refresh_command: 'node dist/libs/actuators/orchestrator-actuator/src/index.js --input libs/actuators/orchestrator-actuator/examples/request-to-status-operator-packet.json',
          refresh_packet_path: 'active/shared/tmp/orchestrator/status-operator-interaction-packet.json',
          llm_touchpoints: [
            {
              stage: 'status-collection',
              purpose: 'Collect governed runtime and traceability signals before answering.',
              output_contract: 'system-status-report',
            },
            {
              stage: 'status-explanation',
              purpose: 'Summarize current state and recommend next actions in human-facing language.',
              output_contract: 'operator-interaction-packet',
            },
          ],
        },
      };
    }
    case 'operator_packet_to_response_preview': {
      const packet = ctx[params.from || 'operator_packet'];
      if (!packet || typeof packet !== 'object') throw new Error('operator_packet_to_response_preview requires operator-interaction-packet');
      const lines: string[] = [];
      lines.push(String(packet.headline || ''));
      if (packet.summary) lines.push(String(packet.summary));
      if (packet.readiness) lines.push(`Readiness: ${String(packet.readiness)}`);
      if (typeof packet.confidence === 'number') lines.push(`Confidence: ${String(packet.confidence)}`);
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
          if (action.suggested_followup_request) lines.push(`  follow-up: ${String(action.suggested_followup_request)}`);
        }
      }
      return {
        ...ctx,
        [params.export_as || 'response_preview']: {
          kind: 'operator-response-preview',
          format: 'plain-text',
          text: lines.join('\n').trim(),
        },
      };
    }
    case 'delivery_pack_to_operator_packet': {
      const pack = ctx[params.from || 'delivery_pack'];
      if (!pack || typeof pack !== 'object') throw new Error('delivery_pack_to_operator_packet requires delivery-pack');
      const artifacts = Array.isArray(pack.artifacts) ? pack.artifacts : [];
      const mainArtifactId = String(pack.main_artifact_id || artifacts[0]?.id || '');
      const mainArtifact = artifacts.find((artifact: any) => artifact?.id === mainArtifactId) || artifacts[0] || null;
      const nextActions = [];
      if (mainArtifact?.path) {
        const mainArtifactPath = String(mainArtifact.path);
        const mainArtifactExt = path.extname(mainArtifactPath).toLowerCase();
        const isLikelyBinaryArtifact = !['.json', '.md', '.txt', '.log', '.xml', '.yaml', '.yml'].includes(mainArtifactExt);
        nextActions.push({
          id: 'review-main-artifact',
          priority: 'now',
          action: `Review main artifact ${String(mainArtifact.id || 'artifact')}`,
          reason: 'Primary deliverable is ready for review.',
          suggested_command: `node dist/scripts/cli.js artifact ${mainArtifactPath}`,
          suggested_followup_request: `Please review the main deliverable ${String(mainArtifact.id || 'artifact')}.`,
        });
        if (isLikelyBinaryArtifact) {
          nextActions.push({
            id: 'open-main-artifact',
            priority: 'next',
            action: `Open main artifact ${String(mainArtifact.id || 'artifact')}`,
            reason: 'The primary deliverable is a binary artifact and may be easier to review in a local viewer.',
            suggested_command: `node dist/scripts/cli.js open-artifact ${mainArtifactPath}`,
            suggested_followup_request: `Please open the main deliverable ${String(mainArtifact.id || 'artifact')} in a local viewer.`,
          });
        }
      }
      if (Array.isArray(pack.artifacts_by_role?.evidence) && pack.artifacts_by_role.evidence.length > 0) {
        const evidenceArtifactId = String(pack.artifacts_by_role.evidence[0] || '');
        const evidenceArtifact = artifacts.find((artifact: any) => artifact?.id === evidenceArtifactId) || null;
        nextActions.push({
          id: 'review-evidence',
          priority: 'next',
          action: 'Review evidence and validation artifacts',
          reason: 'Evidence artifacts are available in the delivery pack.',
          ...(evidenceArtifact?.path ? { suggested_command: `node dist/scripts/cli.js artifact ${String(evidenceArtifact.path)}` } : {}),
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
      const brief = ctx[params.brief_from || 'execution_brief'];
      if (!plan || typeof plan !== 'object') throw new Error('resolution_plan_to_pipeline_bundle requires actuator-resolution-plan');
      if (!brief || typeof brief !== 'object') throw new Error('resolution_plan_to_pipeline_bundle requires actuator-execution-brief');
      const missingInputs = Array.isArray(brief.missing_inputs) ? brief.missing_inputs.map(String) : [];
      const jobs = missingInputs.length === 0
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
      if (!bundle || typeof bundle !== 'object') throw new Error('pipeline_bundle_to_execution_plan_set requires actuator-pipeline-bundle');
      const variables = typeof params.variables === 'object' && params.variables !== null ? params.variables : {};
      const outputDir = String(params.output_dir || `active/shared/runtime/generated-pipelines/${bundle.archetype_id || 'bundle'}`);
      const jobs = Array.isArray(bundle.jobs)
        ? bundle.jobs.map((job: PipelineBundleJob) => renderPipelineBundleJob(job, variables, outputDir))
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
      if (!planSet || typeof planSet !== 'object') throw new Error('run_execution_plan_set requires execution_plan_set');
      const runReport = executeExecutionPlanSet(planSet);
      return {
        ...ctx,
        [params.export_as || 'execution_run_report']: runReport,
      };
    }
    default: return ctx;
  }
}

function loadActuatorRequestArchetypes(): any {
  if (!safeExistsSync(ACTUATOR_ARCHETYPES_PATH)) {
    throw new Error(`Archetype catalog not found: ${ACTUATOR_ARCHETYPES_PATH}`);
  }
  return JSON.parse(safeReadFile(ACTUATOR_ARCHETYPES_PATH, { encoding: 'utf8' }) as string);
}

function detectRequestArchetype(requestText: string, catalog: any): any {
  const text = requestText.toLowerCase();
  const archetypes = Array.isArray(catalog?.archetypes) ? catalog.archetypes : [];
  const scored = archetypes.map((archetype: any) => {
    const hits = (archetype.trigger_keywords || []).filter((keyword: string) => text.includes(String(keyword).toLowerCase())).length;
    return { ...archetype, score: hits };
  });
  scored.sort((a: any, b: any) => b.score - a.score);
  const best = scored[0];
  if (best && best.score > 0) return best;
  return scored.find((item: any) => item.id === catalog.default_archetype) || {
    id: 'structured-delivery',
    score: 0,
    summary_template: 'Generic structured delivery request requiring normalization before execution.',
    normalized_scope: ['request-normalization'],
    target_actuators: ['orchestrator-actuator'],
    deliverables: ['execution brief'],
    required_inputs: ['objective'],
  };
}

function buildPipelineBundleJobs(archetypeId: string): PipelineBundleJob[] {
  switch (archetypeId) {
    case 'status-inquiry':
      return [
        {
          id: 'collect-system-status',
          title: 'Collect runtime and integrity status',
          actuator: 'orchestrator-actuator',
          template_path: 'libs/actuators/orchestrator-actuator/examples/request-to-status-report.json',
          recommended_procedure: 'knowledge/public/orchestration/actuator-intent-normalization.md',
          parameter_overrides: {
            'context.request_text': '{{request_text}}',
          },
          outputs: ['active/shared/tmp/orchestrator/system-status-report.json'],
        },
      ];
    case 'web-design-clone-delivery':
      return [
        {
          id: 'observe-reference',
          title: 'Observe the reference Web experience',
          actuator: 'browser-actuator',
          template_path: 'libs/actuators/browser-actuator/examples/explore-and-export.json',
          recommended_procedure: 'knowledge/public/procedures/service/design-clone-and-build-web.md',
          parameter_overrides: {
            'steps[0].params.url': '{{reference_source}}',
            'steps[3].params.path': 'active/shared/tmp/browser/{{delivery_pack_id}}-reference.png',
            'steps[4].params.path': 'active/shared/tmp/browser/{{delivery_pack_id}}-reference.spec.ts',
            'steps[5].params.path': 'active/shared/tmp/browser/{{delivery_pack_id}}-reference.adf.json',
          },
          outputs: [
            'active/shared/tmp/browser/{{delivery_pack_id}}-reference.png',
            'active/shared/tmp/browser/{{delivery_pack_id}}-reference.spec.ts',
            'active/shared/tmp/browser/{{delivery_pack_id}}-reference.adf.json',
          ],
        },
        {
          id: 'model-web-flow',
          title: 'Generate UI flow and browser execution plan',
          actuator: 'modeling-actuator',
          template_path: 'libs/actuators/modeling-actuator/examples/web-profile-to-browser-plan.json',
          recommended_procedure: 'knowledge/public/orchestration/design-clone-delivery-flow.md',
          parameter_overrides: {
            'steps[0].params.path': '{{web_profile_path}}',
            'steps[3].params.handoff_output_path': 'active/shared/tmp/browser/{{delivery_pack_id}}-handoff.json',
            'steps[4].params.path': 'active/shared/tmp/modeling/{{delivery_pack_id}}-browser-plan.json',
          },
          outputs: [
            'active/shared/tmp/modeling/{{delivery_pack_id}}-browser-plan.json',
          ],
        },
        {
          id: 'package-deliverables',
          title: 'Write governed delivery pack',
          actuator: 'artifact-actuator',
          template_path: 'libs/actuators/artifact-actuator/examples/write-delivery-pack.json',
          recommended_procedure: 'knowledge/public/procedures/service/deliver-design-spec-and-test-pack.md',
          parameter_overrides: {
            'params.packId': '{{delivery_pack_id}}',
            'params.logicalDir': 'active/shared/runtime/delivery-packs/{{delivery_pack_id}}',
            'params.summary': '{{delivery_summary}}',
            'params.requestText': '{{request_text}}',
          },
          outputs: ['active/shared/runtime/delivery-packs/{{delivery_pack_id}}/{{delivery_pack_id}}.json'],
        },
      ];
    case 'mobile-design-clone-delivery':
      return [
        {
          id: 'capture-mobile-ui',
          title: 'Capture native UI and profile-driven interaction surface',
          actuator: 'android-actuator',
          template_path: 'libs/actuators/android-actuator/examples/android-login-passkey-flow-template.json',
          recommended_procedure: 'knowledge/public/procedures/service/design-clone-and-build-mobile.md',
          parameter_overrides: {
            'steps[0].params.path': '{{mobile_profile_path}}',
            'context.context_path': 'active/shared/tmp/android/{{delivery_pack_id}}-flow.context.json',
            'steps[7].params.path': 'active/shared/tmp/android/{{delivery_pack_id}}.png',
          },
          outputs: [
            'active/shared/tmp/android/{{delivery_pack_id}}-flow.context.json',
            'active/shared/tmp/android/{{delivery_pack_id}}.png',
          ],
        },
        {
          id: 'package-deliverables',
          title: 'Write governed delivery pack',
          actuator: 'artifact-actuator',
          template_path: 'libs/actuators/artifact-actuator/examples/write-delivery-pack.json',
          recommended_procedure: 'knowledge/public/procedures/service/deliver-design-spec-and-test-pack.md',
          parameter_overrides: {
            'params.packId': '{{delivery_pack_id}}',
            'params.logicalDir': 'active/shared/runtime/delivery-packs/{{delivery_pack_id}}',
            'params.summary': '{{delivery_summary}}',
            'params.requestText': '{{request_text}}',
          },
          outputs: ['active/shared/runtime/delivery-packs/{{delivery_pack_id}}/{{delivery_pack_id}}.json'],
        },
      ];
    case 'proposal-storyline-delivery':
      return [
        {
          id: 'render-proposal-deck',
          title: 'Generate proposal storyline and render PPTX',
          actuator: 'media-actuator',
          template_path: 'libs/actuators/media-actuator/examples/proposal-storyline-pptx.json',
          recommended_procedure: 'knowledge/public/procedures/service/design-clone-and-build-proposal.md',
          parameter_overrides: {
            'steps[0].params.path': '{{proposal_brief_path}}',
            'context.context_path': 'active/shared/tmp/media/{{delivery_pack_id}}.context.json',
            'steps[5].params.path': 'active/shared/tmp/media/{{delivery_pack_id}}.pptx',
          },
          outputs: [
            'active/shared/tmp/media/{{delivery_pack_id}}.pptx',
            'active/shared/tmp/media/{{delivery_pack_id}}.context.json',
          ],
        },
        {
          id: 'package-deliverables',
          title: 'Write governed delivery pack',
          actuator: 'artifact-actuator',
          template_path: 'libs/actuators/artifact-actuator/examples/write-delivery-pack.json',
          recommended_procedure: 'knowledge/public/procedures/service/deliver-design-spec-and-test-pack.md',
          parameter_overrides: {
            'params.packId': '{{delivery_pack_id}}',
            'params.logicalDir': 'active/shared/runtime/delivery-packs/{{delivery_pack_id}}',
            'params.summary': '{{delivery_summary}}',
            'params.requestText': '{{request_text}}',
          },
          outputs: ['active/shared/runtime/delivery-packs/{{delivery_pack_id}}/{{delivery_pack_id}}.json'],
        },
      ];
    case 'project-document-pack':
      return [
        {
          id: 'instantiate-project-os',
          title: 'Instantiate project operating system scaffold',
          actuator: 'orchestrator-actuator',
          template_path: 'knowledge/public/orchestration/project-operating-system.md',
          recommended_procedure: 'knowledge/public/orchestration/project-operating-system.md',
          parameter_overrides: {
            project_name: '{{project_name}}',
          },
          outputs: ['active/shared/tmp/project-os/{{project_slug}}'],
        },
        {
          id: 'package-deliverables',
          title: 'Write governed delivery pack',
          actuator: 'artifact-actuator',
          template_path: 'libs/actuators/artifact-actuator/examples/write-delivery-pack.json',
          recommended_procedure: 'knowledge/public/procedures/service/deliver-design-spec-and-test-pack.md',
          parameter_overrides: {
            'params.packId': '{{delivery_pack_id}}',
            'params.logicalDir': 'active/shared/runtime/delivery-packs/{{delivery_pack_id}}',
            'params.summary': '{{delivery_summary}}',
            'params.requestText': '{{request_text}}',
          },
          outputs: ['active/shared/runtime/delivery-packs/{{delivery_pack_id}}/{{delivery_pack_id}}.json'],
        },
      ];
    default:
      return [
        {
          id: 'normalize-request',
          title: 'Normalize request and prepare governed delivery pack',
          actuator: 'artifact-actuator',
          template_path: 'libs/actuators/artifact-actuator/examples/write-delivery-pack.json',
          recommended_procedure: 'knowledge/public/orchestration/actuator-intent-normalization.md',
          parameter_overrides: {
            'params.packId': '{{delivery_pack_id}}',
            'params.logicalDir': 'active/shared/runtime/delivery-packs/{{delivery_pack_id}}',
            'params.summary': '{{delivery_summary}}',
            'params.requestText': '{{request_text}}',
          },
          outputs: ['active/shared/runtime/delivery-packs/{{delivery_pack_id}}/{{delivery_pack_id}}.json'],
        },
      ];
  }
}

function renderPipelineBundleJob(job: PipelineBundleJob, variables: Record<string, unknown>, outputDir: string): ExecutionPlanSetJob {
  const renderedOutputPath = path.join(outputDir, `${job.id}.json`);
  if (!job.template_path.endsWith('.json')) {
    return {
      ...job,
      output_path: renderedOutputPath,
      skipped_reason: 'template_path is not a JSON pipeline template',
    };
  }

  const templateFullPath = path.resolve(process.cwd(), job.template_path);
  if (!safeExistsSync(templateFullPath)) {
    return {
      ...job,
      output_path: renderedOutputPath,
      skipped_reason: `template not found: ${job.template_path}`,
    };
  }

  const raw = JSON.parse(safeReadFile(templateFullPath, { encoding: 'utf8' }) as string) as Record<string, unknown>;
  const renderedPipeline = applyPathOverrides(raw, job.parameter_overrides || {}, variables);
  return {
    ...job,
    output_path: renderedOutputPath,
    rendered_pipeline: renderedPipeline,
    outputs: (job.outputs || []).map((item) => renderTemplateString(String(item), variables)),
  };
}

function executeExecutionPlanSet(planSet: any) {
  const jobs = Array.isArray(planSet.jobs) ? planSet.jobs : [];
  const results: ExecutionPlanRunResult[] = [];
  for (const job of jobs) {
    if (job?.skipped_reason) {
      results.push({
        id: String(job.id || 'unknown'),
        actuator: String(job.actuator || 'unknown'),
        input_path: job.output_path ? String(job.output_path) : undefined,
        status: 'skipped',
        skipped_reason: String(job.skipped_reason),
      });
      continue;
    }

    try {
      const actuator = String(job.actuator || '');
      const inputPath = String(job.output_path || '');
      const entryPath = resolveActuatorEntryPath(actuator);
      const rawOutput = safeExec('node', [entryPath, '--input', inputPath], { cwd: process.cwd(), timeoutMs: 120000 });
      let parsed: unknown = rawOutput.trim();
      try {
        parsed = JSON.parse(rawOutput);
      } catch {
        // leave as raw string
      }
      results.push({
        id: String(job.id || 'unknown'),
        actuator,
        input_path: inputPath,
        status: 'succeeded',
        output: parsed,
      });
    } catch (error: any) {
      results.push({
        id: String(job.id || 'unknown'),
        actuator: String(job.actuator || 'unknown'),
        input_path: job.output_path ? String(job.output_path) : undefined,
        status: 'failed',
        error: error.message,
      });
    }
  }

  return {
    kind: 'actuator-execution-run-report',
    status: results.every((result) => result.status === 'succeeded') ? 'succeeded' : 'partial',
    total_jobs: results.length,
    results,
  };
}

function collectCommandHealth(command: string, args: string[]) {
  try {
    const output = safeExec(command, args, { cwd: process.cwd(), timeoutMs: 120000 });
    return { ok: true, detail: output.trim() };
  } catch (error: any) {
    return { ok: false, detail: error.message };
  }
}

function parseJsonCommandOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return { raw: output.trim() };
  }
}

function buildClarificationQuestion(inputName: string): string {
  switch (inputName) {
    case 'reference source': return '参照元となる画面、URL、資料、またはアプリ名を指定してください。';
    case 'preserved elements': return '踏襲したい要素は何ですか。配色、レイアウト、トーン、導線などを指定してください。';
    case 'new concept': return '新しく実現したいコンセプトや目的を一文で指定してください。';
    case 'target environment': return '対象環境を指定してください。例: local / staging / production-like。';
    case 'execution environment': return '実行環境を指定してください。例: simulator / emulator / local browser。';
    case 'source materials': return 'ベースにする資料や入力ファイルを指定してください。';
    case 'target audience': return '想定読者または利用者を指定してください。';
    case 'storyline': return 'どういう流れで伝えたいか、章立てまたは要点を指定してください。';
    case 'required output format': return '必要な出力形式を指定してください。例: pptx / docx / pdf。';
    default: return `${inputName} を指定してください。`;
  }
}

function deriveExecutionBriefReadiness(missingInputs: string[], requestText: string) {
  if (missingInputs.length > 0) {
    return {
      level: 'needs_clarification',
      reason: `Missing required inputs: ${missingInputs.join(', ')}`,
    };
  }
  if (/production|本番/i.test(requestText)) {
    return {
      level: 'needs_external_asset',
      reason: 'The request references a higher-risk environment and should be confirmed before execution.',
    };
  }
  return {
    level: 'fully_automatable',
    reason: 'Required inputs are present and actuator planning can proceed.',
  };
}

function deriveStatusNextActions(snapshot: any, findings: Array<{ id: string; severity: string; message: string; detail?: string }>) {
  const actions: Array<{
    id: string;
    priority: 'now' | 'next' | 'later';
    next_action_type?: 'execute_now' | 'inspect' | 'clarify' | 'start_mission' | 'resume_mission';
    action: string;
    reason: string;
    suggested_command?: string;
    suggested_pipeline_path?: string;
    suggested_followup_request?: string;
  }> = [];
  for (const finding of findings) {
    if (finding.id.startsWith('surface-') && finding.severity === 'error') {
      const surfaceId = finding.id.replace(/^surface-/, '');
      actions.push({
        id: `restart-${surfaceId}`,
        priority: 'now',
        next_action_type: 'execute_now',
        action: `Investigate logs and restart ${surfaceId}`,
        reason: finding.detail || finding.message,
        suggested_command: `node dist/scripts/surface_runtime.js --action reconcile --surface ${surfaceId}`,
        suggested_followup_request: `${surfaceId} を reconcile して状態を再確認してください。`,
      });
      continue;
    }
    if (finding.id === 'esm-integrity') {
      actions.push({
        id: 'fix-esm-integrity',
        priority: 'now',
        next_action_type: 'execute_now',
        action: 'Run `pnpm run check:esm` and resolve import/runtime mismatches',
        reason: finding.detail || finding.message,
        suggested_command: 'pnpm run check:esm',
        suggested_followup_request: 'ESM integrity の失敗箇所を修正してください。',
      });
      continue;
    }
    if (finding.id === 'catalog-integrity') {
      actions.push({
        id: 'fix-catalog-integrity',
        priority: 'now',
        next_action_type: 'execute_now',
        action: 'Run `pnpm run check:catalogs` and repair invalid orchestration catalogs',
        reason: finding.detail || finding.message,
        suggested_command: 'pnpm run check:catalogs',
        suggested_followup_request: 'catalog integrity の失敗箇所を修正してください。',
      });
      continue;
    }
    if (finding.id === 'active-missions') {
      actions.push({
        id: 'review-active-missions',
        priority: 'next',
        next_action_type: 'inspect',
        action: 'Review active missions and confirm checkpoints or finish criteria',
        reason: finding.detail || finding.message,
        suggested_followup_request: 'active な mission の checkpoint または finish 条件を確認してください。',
      });
      continue;
    }
    if (finding.id === 'target-mission' && snapshot.mission_status?.target?.status === 'completed') {
      const missionId = String(snapshot.mission_status.target.mission_id);
      actions.push({
        id: 'review-target-mission-artifacts',
        priority: 'next',
        next_action_type: 'inspect',
        action: `Review artifacts for ${missionId}`,
        reason: 'The requested mission is already completed.',
        suggested_command: `node dist/scripts/mission_controller.js status ${missionId}`,
        suggested_followup_request: `${missionId} の成果物と distillation を確認してください。`,
      });
      continue;
    }
    if (finding.id === 'target-mission' && snapshot.mission_status?.target?.status === 'active') {
      const missionId = String(snapshot.mission_status.target.mission_id);
      actions.push({
        id: 'continue-target-mission',
        priority: 'now',
        next_action_type: 'resume_mission',
        action: `Resume or verify ${missionId}`,
        reason: 'The requested mission is still active.',
        suggested_command: `node dist/scripts/mission_controller.js resume ${missionId}`,
        suggested_followup_request: `${missionId} を再開して進捗を確認してください。`,
      });
      continue;
    }
    if (finding.id === 'target-project') {
      const projectPath = snapshot.project_status?.target?.path;
      actions.push({
        id: 'review-target-project-ledger',
        priority: 'next',
        next_action_type: 'inspect',
        action: 'Inspect the project mission ledger and gate artifacts',
        reason: finding.detail || finding.message,
        suggested_followup_request: '対象 project の mission ledger と gate 資料を確認してください。',
        ...(projectPath ? { suggested_command: `sed -n '1,220p' ${projectPath}/04_control/mission-ledger.md` } : {}),
      });
    }
  }
  if (actions.length === 0) {
    actions.push({
      id: 'no-action-required',
      priority: 'later',
      next_action_type: 'inspect',
      action: 'No immediate action required',
      reason: 'The status report did not identify corrective work.',
      suggested_followup_request: '必要なら別の mission または project を指定して詳細状態を確認してください。',
    });
  }
  return actions;
}

function collectMissionStatusSnapshot(targetId?: string) {
  const missionRoot = path.resolve(process.cwd(), 'active/missions');
  if (!safeExistsSync(missionRoot)) {
    return { metrics: { total: 0, active: 0, completed: 0 }, missions: [] };
  }
  const missionFiles = getAllFiles(missionRoot, { maxDepth: 4 })
    .filter((filePath) => filePath.endsWith('mission-state.json'));
  const missions = missionFiles.map((filePath) => {
    const logicalPath = path.relative(process.cwd(), filePath);
    const state = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as Record<string, any>;
    return {
      mission_id: String(state.mission_id || path.basename(path.dirname(filePath))),
      tier: String(state.tier || 'unknown'),
      status: String(state.status || 'unknown'),
      project_id: state.relationships?.project?.project_id || null,
      assigned_persona: state.assigned_persona || null,
      path: logicalPath,
    };
  });
  const target = targetId
    ? missions.find((item) => item.mission_id === targetId || item.project_id === targetId) || null
    : null;
  const filtered = targetId
    ? missions.filter((item) => item.mission_id === targetId || item.project_id === targetId)
    : missions;
  return {
    metrics: {
      total: filtered.length,
      active: filtered.filter((item) => item.status === 'active').length,
      completed: filtered.filter((item) => item.status === 'completed').length,
    },
    missions: filtered,
    target,
  };
}

function collectProjectStatusSnapshot(targetProjectId?: string) {
  const candidateRoots = [
    path.resolve(process.cwd(), 'active/projects'),
    path.resolve(process.cwd(), 'active/shared/tmp/project-os'),
  ];
  const projectEntries: Array<Record<string, any>> = [];
  for (const root of candidateRoots) {
    if (!safeExistsSync(root)) continue;
    const readmes = getAllFiles(root, { maxDepth: 3 })
      .filter((filePath) => filePath.endsWith('README.md'));
    for (const readmePath of readmes) {
      const projectRoot = path.dirname(readmePath);
      const ledgerPath = path.join(projectRoot, '04_control', 'mission-ledger.json');
      const readme = safeReadFile(readmePath, { encoding: 'utf8' }) as string;
      const titleLine = readme.split('\n').find((line) => line.startsWith('# ')) || '# Unknown Project';
      const ledger = safeExistsSync(ledgerPath)
        ? JSON.parse(safeReadFile(ledgerPath, { encoding: 'utf8' }) as string)
        : { entries: [] };
      const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
      projectEntries.push({
        project_id: ledger.project_id || null,
        project_name: titleLine.replace(/^#\s+/, '').trim(),
        path: path.relative(process.cwd(), projectRoot),
        linked_missions: entries.length,
        active_missions: entries.filter((entry: any) => entry.status === 'active').length,
      });
    }
  }
  const deduped = Array.from(new Map(projectEntries.map((item) => [String(item.path), item])).values());
  const target = targetProjectId
    ? deduped.find((item) =>
        String(item.project_id || '') === targetProjectId ||
        String(item.project_name).includes(targetProjectId) ||
        String(item.path).includes(targetProjectId.toLowerCase()),
      ) || null
    : null;
  const filtered = targetProjectId
    ? deduped.filter((item) =>
        String(item.project_id || '') === targetProjectId ||
        String(item.project_name).includes(targetProjectId) ||
        String(item.path).includes(targetProjectId.toLowerCase()),
      )
    : deduped;
  return {
    metrics: {
      project_count: filtered.length,
      linked_missions: filtered.reduce((sum, item) => sum + Number(item.linked_missions || 0), 0),
      active_missions: filtered.reduce((sum, item) => sum + Number(item.active_missions || 0), 0),
    },
    projects: filtered,
    target,
  };
}

function resolveActuatorEntryPath(actuator: string): string {
  const relativePath = `dist/libs/actuators/${actuator}/src/index.js`;
  const fullPath = path.resolve(process.cwd(), relativePath);
  if (!safeExistsSync(fullPath)) {
    throw new Error(`Actuator entry not found for ${actuator}: ${relativePath}`);
  }
  return fullPath;
}

function applyPathOverrides(
  template: Record<string, unknown>,
  overrides: Record<string, unknown>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
  for (const [overridePath, overrideValue] of Object.entries(overrides)) {
    setByPath(clone, overridePath, renderTemplateValue(overrideValue, variables));
  }
  return clone;
}

function renderTemplateValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return renderTemplateString(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateValue(item, variables));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, renderTemplateValue(nested, variables)]),
    );
  }
  return value;
}

function renderTemplateString(input: string, variables: Record<string, unknown>): string {
  return input.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
    const lookup = String(key).trim();
    const value = variables[lookup];
    return value === undefined ? `{{${lookup}}}` : String(value);
  });
}

function setByPath(target: Record<string, unknown>, overridePath: string, value: unknown) {
  const tokens = overridePath.match(/[^.[\]]+/g) || [];
  if (tokens.length === 0) return;
  let cursor: any = target;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    const nextIsIndex = /^\d+$/.test(nextToken);
    const currentValue = cursor[token];
    if (currentValue === undefined) {
      cursor[token] = nextIsIndex ? [] : {};
    }
    cursor = cursor[token];
  }
  cursor[tokens[tokens.length - 1]] = value;
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  switch (op) {
    case 'write_file':
      const out = path.resolve(rootDir, resolveVars(params.path, ctx));
      const content = params.from ? ctx[params.from] : (ctx.last_transform ?? ctx.last_capture);
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      await withRetry(async () => {
        safeWriteFile(out, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      }, params.retry || { maxRetries: 3 });
      break;
    case 'mkdir': safeMkdir(path.resolve(rootDir, resolveVars(params.path, ctx)), { recursive: true }); break;
    case 'symlink':
      const target = path.resolve(rootDir, resolveVars(params.target, ctx));
      const source = path.resolve(rootDir, resolveVars(params.source, ctx));
      if (safeExistsSync(target)) safeUnlinkSync(target);
      if (!safeExistsSync(path.dirname(target))) safeMkdir(path.dirname(target), { recursive: true });
      safeSymlinkSync(source, target, params.type || 'dir');
      break;
    case 'git_checkpoint':
      await withRetry(async () => {
        safeExec('git', ['add', '.'], { cwd: rootDir });
        safeExec('git', ['commit', '-m', resolveVars(params.message || 'checkpoint', ctx)], { cwd: rootDir });
      }, { maxRetries: 2, initialDelayMs: 1000 });
      break;
    case 'log': logger.info(`[ORCH_LOG] ${resolveVars(params.message || 'Action completed', ctx)}`); break;
    case 'write_execution_plan_set': {
      const planSet = ctx[params.from || 'execution_plan_set'];
      if (!planSet || typeof planSet !== 'object') throw new Error('write_execution_plan_set requires execution_plan_set');
      for (const job of Array.isArray(planSet.jobs) ? planSet.jobs : []) {
        if (!job?.output_path || !job?.rendered_pipeline || job.skipped_reason) continue;
        const logicalOutputPath = String(job.output_path);
        const logicalOutputDir = path.dirname(logicalOutputPath);
        if (!safeExistsSync(logicalOutputDir)) safeMkdir(logicalOutputDir, { recursive: true });
        safeWriteFile(logicalOutputPath, JSON.stringify(job.rendered_pipeline, null, 2));
      }
      break;
    }
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: OrchestratorAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/orchestration-strategy.json');
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

/**
 * CLI Runner
 */
const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
