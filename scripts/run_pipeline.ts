import {
  TraceContext,
  finalizeAndPersist,
  classifyError,
  formatClassification,
  logger,
  safeExec,
  safeReadFile,
  safeExistsSync,
  resolveVars,
  evaluateCondition,
  capabilityEntry,
  findMissionPath,
  missionEvidenceDir,
  pathResolver,
} from '@agent/core';
import * as nodePath from 'node:path';
import { derivePipelineStatus, type PipelineAdfStep } from '@agent/core/pipeline-contract';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readValidatedPipelineAdf } from './refactor/adf-input.js';

type DispatchFunc = (op: string, params: any, ctx: Record<string, unknown>, type?: string) => Promise<{ handled: boolean; ctx: Record<string, unknown> }>;

const dispatchCache: Record<string, DispatchFunc> = {};
const moduleCache: Record<string, any> = {};

interface RunStepsOptions {
  trace?: TraceContext;
  _includeStack?: ReadonlySet<string>;
}

async function loadActuatorDispatch(domain: string): Promise<DispatchFunc> {
  if (dispatchCache[domain]) return dispatchCache[domain];
  
  if (domain === 'reasoning') {
    dispatchCache[domain] = async (op, params, ctx, type) => {
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
        const prompt = `Instruction: ${resolvedInstruction || 'Analyze the context.'}\nContext: ${JSON.stringify(resolvedContext)}`;
        const response = shouldUseSubagentForReasoningStep(params)
          ? await backend.delegateTask(String(resolvedInstruction || 'Analyze the context.'), JSON.stringify(resolvedContext))
          : await backend.prompt(prompt);
        return { handled: true, ctx: { ...ctx, [params.export_as || 'last_reasoning']: response } };
      }
      return { handled: false, ctx };
    };
    return dispatchCache[domain];
  }

  const { resolveProviderCapabilityId, invokeProviderCapability } = await import('@agent/core/provider-bridge');

  dispatchCache[domain] = async (op, params, ctx, type) => {
    const resolvedId = resolveProviderCapabilityId(domain, op);
    if (resolvedId) {
      const result = await invokeProviderCapability({
        capabilityId: resolvedId,
        args: params.args,
        payload: params.payload || params.instruction || params.prompt,
        context: ctx,
      });
      let parsed = result;
      try { parsed = JSON.parse(result); } catch {}
      return { handled: true, ctx: { ...ctx, [params.export_as || 'last_provider_result']: parsed } };
    }

    let result = { handled: false, ctx };

    try {
      if (!moduleCache[domain]) {
        const entry = capabilityEntry(`${domain}-actuator`);
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
            options: ctx.__pipeline_options
          });
          result = { handled: true, ctx: actionResult };
        } catch (err: any) {
          try {
            const directResult = await mod.handleAction({ 
              action: op, 
              params: { ...params, context: ctx }
            });
            result = { handled: true, ctx: { ...ctx, [params.export_as || 'last_action_result']: directResult } };
          } catch (err2) {
            logger.info(`  [SYS_PIPELINE] Actuator fallback failed for domain: ${domain}, op: ${op}`);
          }
        }
      }
    } catch (err) {}
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
    if (domain === 'agent' && (action === 'list-manifests' || action === 'list_manifests')) return 'agent:list_manifests';
    if (domain === 'agent' && (action === 'list-runtimes' || action === 'list_runtimes')) return 'agent:list_runtimes';
    
    if (domain === 'mission') return `system:${action}`;
    return op;
  }
  if (op === 'if') return 'core:if';
  return `system:${op}`;
}

function resolveLogMessage(params: Record<string, unknown>, ctx: Record<string, unknown>): string {
  const template = params.message ?? params.template ?? params.text ?? '';
  return String(resolveVars(template, ctx));
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
  const relativeRef = normalized.startsWith('pipelines/') ? normalized.slice('pipelines/'.length) : normalized;
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

export async function runSteps(
  steps: PipelineAdfStep[],
  initialCtx: Record<string, unknown> = {},
  opts: RunStepsOptions = {},
) {
  let ctx: Record<string, unknown> = { ...initialCtx };
  const results: { op: string; status: 'success' | 'failed'; error?: string }[] = [];
  const shellBin = 'bash';
  const rootDir = pathResolver.rootDir();

  for (const step of steps) {
    const normalizedOp = normalizePipelineOp(step.op);
    try {
      const [domain, action] = normalizedOp.split(':');
      const params = (step.params || {}) as Record<string, unknown>;
      opts.trace?.startSpan(normalizedOp, {
        step_index: results.length,
        ...(step.type ? { step_type: step.type } : {}),
      });
      opts.trace?.addEvent('step.started');

      if (domain === 'system' && action === 'log') {
        logger.info(resolveLogMessage(params, ctx));
      } else if (domain === 'system' && action === 'shell') {
        const cmd = String(resolveVars(params.cmd || '', ctx));
        const env = Object.fromEntries(
          Object.entries((params.env || {}) as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === 'string' ? String(resolveVars(value, ctx)) : String(value),
          ]),
        ) as Record<string, string>;
        const output = safeExec(shellBin, ['-c', cmd], { cwd: rootDir, env }).trim();
        if (params.export_as && typeof params.export_as === 'string') {
          ctx = { ...ctx, [params.export_as]: output };
        }
      } else if (domain === 'core' && action === 'if') {
        const cond = params.condition;
        const conditionResult = evaluateCondition(cond, ctx);
        const branch = conditionResult ? params.then : params.else;
        if (Array.isArray(branch)) {
          const nested = await runSteps(branch as PipelineAdfStep[], ctx, opts);
          ctx = nested.context;
          results.push(...nested.results);
        }
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
      } else if (domain === 'core' && action === 'include') {
        const fragmentRef = String(resolveVars(params.fragment || '', ctx));
        if (!fragmentRef) throw new Error('core:include requires "fragment" param');
        const fragmentPath = resolveFragmentPath(fragmentRef);
        if (!safeExistsSync(fragmentPath)) {
          throw new Error(`core:include: fragment not found: ${fragmentRef} (resolved: ${fragmentPath})`);
        }
        // Circular include detection
        const includeStack = opts._includeStack ?? new Set<string>();
        if (includeStack.has(fragmentPath)) {
          throw new Error(`core:include: circular reference detected — ${fragmentRef} is already in the include chain`);
        }
        const fragmentJson = JSON.parse(String(safeReadFile(fragmentPath, { encoding: 'utf8' })));
        const fragmentSteps: PipelineAdfStep[] = (fragmentJson.steps || []).map((s: any) => ({ ...s, params: s.params || {} }));
        // Merge optional inline context overrides, resolving any template vars in values.
        const inlineCtx: Record<string, unknown> = params.context && typeof params.context === 'object'
          ? Object.fromEntries(
              Object.entries(params.context as Record<string, unknown>).map(([k, v]) => [
                k,
                typeof v === 'string' ? resolveVars(v, ctx) : v,
              ]),
            )
          : {};
        const childOpts: RunStepsOptions = { ...opts, _includeStack: new Set([...includeStack, fragmentPath]) };
        const nested = await runSteps(fragmentSteps, { ...ctx, ...inlineCtx }, childOpts);
        ctx = nested.context;
        results.push(...nested.results);
        if (nested.status === 'failed') {
          return { status: derivePipelineStatus(results), results, context: ctx };
        }
      } else if (domain === 'core' && action === 'wait') {
        const ms = Number(resolveVars(params.duration_ms || params.ms || 1000, ctx));
        await new Promise((resolve) => setTimeout(resolve, ms));
      } else if (domain === 'core' && action === 'transform') {
        const { Buffer } = await import('node:buffer');
        const vm = await import('node:vm');
        const util = await import('node:util');
        const input = resolveVars(params.input || ctx, ctx);
        const script = String(params.script || 'input');
        const sandbox = { 
          Buffer, 
          input, 
          ctx: { ...ctx },
          console: { 
            log: (...args: any[]) => logger.info(`[TRANSFORM-LOG] ${args.map(a => typeof a === 'object' ? util.inspect(a) : a).join(' ')}`),
          } 
        };
        vm.createContext(sandbox);
        const result = await new vm.Script(script).runInContext(sandbox);
        if (params.export_as && typeof params.export_as === 'string') {
          ctx = { ...ctx, [params.export_as]: result };
        } else {
          ctx.last_transform = result;
        }
      } else {
        const dispatch = await loadActuatorDispatch(domain);
        const result = await dispatch(action, params, ctx, step.type);
        if (!result.handled) {
          throw new Error(`Unsupported pipeline op: ${step.op}`);
        }
        // If the actuator returned a standard result object with a nested context, extract it.
        // Otherwise, use the returned object as the new context (backward compatibility).
        if (result.ctx && typeof result.ctx === 'object' && 'context' in result.ctx) {
          ctx = result.ctx.context as Record<string, unknown>;
        } else {
          ctx = result.ctx;
        }
      }

      results.push({ op: normalizedOp, status: 'success' });
      opts.trace?.addEvent('step.completed');
      opts.trace?.endSpan('ok');
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const failure = formatPipelineFailure(err);
      results.push({ op: normalizedOp, status: 'failed', error: message });
      opts.trace?.addEvent('step.failed', {
        error: message,
        error_category: failure.classification.category,
        error_rule_id: failure.classification.ruleId,
      });
      opts.trace?.endSpan('error', failure.summary);
      return { status: derivePipelineStatus(results), results, context: ctx };
    }
  }

  return { status: derivePipelineStatus(results), results, context: ctx };
}

export async function main() {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .option('context', { alias: 'c', type: 'string', describe: 'JSON string merged into pipeline.context (overrides)' })
    .parseSync();

  const pipeline = readValidatedPipelineAdf(argv.input as string);

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
  // Auto-inject mission path vars when MISSION_ID env is set or context carries mission_id.
  const firstNonEmpty = (...candidates: (string | undefined)[]): string | undefined =>
    candidates.find((v): v is string => typeof v === 'string' && v.length > 0);
  const missionId = firstNonEmpty(
    overrideContext.mission_id as string | undefined,
    baseContext.mission_id as string | undefined,
    process.env.MISSION_ID,
  );
  const autoContext: Record<string, unknown> = {};
  if (missionId) {
    const missionPath = findMissionPath(missionId);
    const evidenceDir = missionEvidenceDir(missionId);
    if (missionPath) {
      autoContext.mission_dir = nodePath.relative(pathResolver.rootDir(), missionPath) || missionPath;
      autoContext.mission_tier = nodePath.basename(nodePath.dirname(missionPath));
    }
    if (evidenceDir) {
      autoContext.mission_evidence_dir = nodePath.relative(pathResolver.rootDir(), evidenceDir) || evidenceDir;
    }
  }
  autoContext.browser_session_id = `${pipeline.pipeline_id || path.basename(String(argv.input), path.extname(String(argv.input)))}`;
  autoContext.repo_root = pathResolver.rootDir();
  autoContext.platform_name = process.platform;
  autoContext.node_options = process.env.NODE_OPTIONS || '';
  autoContext.run_utc_now = new Date().toISOString();
  autoContext.__pipeline_options = pipeline.options || {}; // Inject options
  const mergedContext = { ...baseContext, ...autoContext, ...overrideContext };

  logger.info(`🚀 [PIPELINE] Running ADF pipeline: ${pipeline.name || argv.input}`);
  logger.info(`   [PIPELINE] Mission ID: ${missionId || 'NONE'}`);
  logger.info(`   [PIPELINE] Evidence Dir: ${autoContext.mission_evidence_dir || 'UNDEFINED'}`);

  const pipelineId = String(
    pipeline.pipeline_id || pipeline.id || path.basename(String(argv.input), path.extname(String(argv.input))),
  );
  const trace = new TraceContext(`pipeline:${pipelineId}`, {
    ...(missionId ? { missionId } : {}),
    pipelineId,
  });
  trace.addArtifact('file', String(argv.input), 'Pipeline ADF input');

  try {
    const result = await runSteps(
      (pipeline.steps || []).map((step) => ({ ...step, params: step.params || {} })),
      mergedContext,
      { trace },
    );
    const persisted = finalizeAndPersist(trace);
    result.context.trace_summary = persisted.trace.rootSpan.status;
    result.context.trace_persisted_path = nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path;
    logger.info(`   [PIPELINE] Trace: ${result.context.trace_persisted_path}`);
    if (result.status === 'succeeded') {
      logger.success(`✅ [PIPELINE] Completed: ${pipeline.name || argv.input}`);
      if (autoContext.__pipeline_options && (autoContext.__pipeline_options as any).keep_alive) {
        logger.info('   [PROCESS] Browser session kept alive per pipeline options. Terminal will remain open.');
      } else {
        process.exit(0);
      }
    } else {
      const failed = result.results.find((entry) => entry.status === 'failed');
      if (failed) {
        const failure = formatPipelineFailure(failed.error || 'unknown error');
        logger.error(`❌ [PIPELINE] Failed step: ${failed.op} :: ${failure.summary}`);
      }
      logger.error(`❌ [PIPELINE] Failed: ${pipeline.name || argv.input}`);
      process.exit(1);
    }
  } catch (err: any) {
    const failure = formatPipelineFailure(err);
    trace.addEvent('pipeline.error', {
      error: err?.message ?? String(err),
      error_category: failure.classification.category,
      error_rule_id: failure.classification.ruleId,
    });
    const persisted = finalizeAndPersist(trace);
    logger.info(`   [PIPELINE] Trace: ${nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`);
    logger.error(`❌ [PIPELINE] Error: ${failure.summary}`);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
