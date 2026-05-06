import { logger, safeExec, resolveVars, evaluateCondition, capabilityEntry, findMissionPath, missionEvidenceDir, pathResolver } from '@agent/core';
import * as nodePath from 'node:path';
import { derivePipelineStatus, type PipelineAdfStep } from '@agent/core/pipeline-contract';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readValidatedPipelineAdf } from './refactor/adf-input.js';

type DispatchFunc = (op: string, params: any, ctx: Record<string, unknown>, type?: string) => Promise<{ handled: boolean; ctx: Record<string, unknown> }>;

const dispatchCache: Record<string, DispatchFunc> = {};

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

  // Check for Provider Bridge (Gemini, GH, Codex native tools)
  const { resolveProviderCapabilityId, invokeProviderCapability } = await import('@agent/core/provider-bridge');

  dispatchCache[domain] = async (op, params, ctx, type) => {
    // Try to resolve a registered capability for this domain:op
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

    // Standard actuator lookup fallback...
    try {
      const entry = capabilityEntry(`${domain}-actuator`);
      const mod = await import(pathToFileURL(entry).href);
      
      // Priority 1: dispatchDecisionOp
      if (typeof mod.dispatchDecisionOp === 'function') {
        result = await mod.dispatchDecisionOp(op, params, ctx);
      }
      
      // Priority 2: handleAction
      if (!result.handled && typeof mod.handleAction === 'function') {
        try {
          const actionResult = await mod.handleAction({ 
            action: 'pipeline', 
            steps: [{ type: type || 'apply', op, params }], 
            context: ctx 
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
  if (op.includes(':')) return op;
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

function shouldUseSubagentForReasoningStep(params: Record<string, unknown>): boolean {
  if (params.use_subagent === true) return true;
  const mode = String(params.execution_mode || params.mode || '');
  return mode === 'subagent' || mode === 'delegate';
}

export async function runSteps(steps: PipelineAdfStep[], initialCtx: Record<string, unknown> = {}) {
  let ctx: Record<string, unknown> = { ...initialCtx };
  const results: { op: string; status: 'success' | 'failed'; error?: string }[] = [];
  const shellBin = process.env.SHELL || 'bash';
  const rootDir = pathResolver.rootDir();

  for (const step of steps) {
    try {
      const normalizedOp = normalizePipelineOp(step.op);
      const [domain, action] = normalizedOp.split(':');
      const params = (step.params || {}) as Record<string, unknown>;

      if (domain === 'system' && action === 'log') {
        logger.info(resolveLogMessage(params, ctx));
      } else if (domain === 'system' && action === 'shell') {
        const cmd = String(resolveVars(params.cmd || '', ctx));
        const env = (params.env || {}) as Record<string, string>;
        const output = safeExec(shellBin, ['-lc', cmd], { cwd: rootDir, env }).trim();
        if (params.export_as && typeof params.export_as === 'string') {
          ctx = { ...ctx, [params.export_as]: output };
        }
      } else if (domain === 'core' && action === 'if') {
        const branch = evaluateCondition(params.condition, ctx) ? params.then : params.else;
        if (Array.isArray(branch)) {
          const nested = await runSteps(branch as PipelineAdfStep[], ctx);
          ctx = nested.context;
          results.push(...nested.results);
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
    } catch (err: any) {
      results.push({ op: normalizePipelineOp(step.op), status: 'failed', error: err.message });
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
  const mergedContext = { ...baseContext, ...autoContext, ...overrideContext };

  logger.info(`🚀 [PIPELINE] Running ADF pipeline: ${pipeline.name || argv.input}`);
  logger.info(`   [PIPELINE] Mission ID: ${missionId || 'NONE'}`);
  logger.info(`   [PIPELINE] Evidence Dir: ${autoContext.mission_evidence_dir || 'UNDEFINED'}`);

  try {
    const result = await runSteps(
      (pipeline.steps || []).map((step) => ({ ...step, params: step.params || {} })),
      mergedContext,
    );
    if (result.status === 'succeeded') {
      logger.success(`✅ [PIPELINE] Completed: ${pipeline.name || argv.input}`);
    } else {
      const failed = result.results.find((entry) => entry.status === 'failed');
      if (failed) {
        logger.error(`❌ [PIPELINE] Failed step: ${failed.op} :: ${failed.error || 'unknown error'}`);
      }
      logger.error(`❌ [PIPELINE] Failed: ${pipeline.name || argv.input}`);
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`❌ [PIPELINE] Error: ${err.message}`);
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
