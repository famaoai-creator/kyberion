import { logger, safeExec, resolveVars, evaluateCondition, capabilityEntry, findMissionPath, missionEvidenceDir } from '@agent/core';
import { rootResolve } from '@agent/core/path-resolver';
import * as nodePath from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { derivePipelineStatus, type PipelineAdfStep, validatePipelineAdf } from '@agent/core/pipeline-contract';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type WisdomDispatch = (op: string, params: any, ctx: Record<string, unknown>) => Promise<{ handled: boolean; ctx: Record<string, unknown> }>;

let wisdomDispatchCache: WisdomDispatch | null = null;

async function loadWisdomDispatch(): Promise<WisdomDispatch> {
  if (wisdomDispatchCache) return wisdomDispatchCache;
  const entry = capabilityEntry('wisdom-actuator');
  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.dispatchDecisionOp !== 'function') {
    throw new Error('wisdom-actuator does not export dispatchDecisionOp — rebuild required');
  }
  wisdomDispatchCache = mod.dispatchDecisionOp;
  return wisdomDispatchCache;
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

export async function runSteps(steps: PipelineAdfStep[], initialCtx: Record<string, unknown> = {}) {
  let ctx: Record<string, unknown> = { ...initialCtx };
  const results: { op: string; status: 'success' | 'failed'; error?: string }[] = [];
  const shellBin = process.env.SHELL || 'bash';

  for (const step of steps) {
    try {
      const normalizedOp = normalizePipelineOp(step.op);
      const [domain, action] = normalizedOp.split(':');
      const params = (step.params || {}) as Record<string, unknown>;

      if (domain === 'system' && action === 'log') {
        logger.info(resolveLogMessage(params, ctx));
      } else if (domain === 'system' && action === 'shell') {
        const cmd = String(resolveVars(params.cmd || '', ctx));
        const output = safeExec(shellBin, ['-lc', cmd], { cwd: process.cwd() }).trim();
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
      } else if (domain === 'wisdom') {
        const dispatch = await loadWisdomDispatch();
        const decision = await dispatch(action, params, ctx);
        if (!decision.handled) {
          throw new Error(`Unsupported pipeline op: ${step.op}`);
        }
        ctx = decision.ctx;
      } else {
        throw new Error(`Unsupported pipeline op: ${step.op}`);
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

  const inputPath = rootResolve(argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const pipeline = validatePipelineAdf(JSON.parse(inputContent));

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
      autoContext.mission_dir = nodePath.relative(process.cwd(), missionPath) || missionPath;
      autoContext.mission_tier = nodePath.basename(nodePath.dirname(missionPath));
    }
    if (evidenceDir) {
      autoContext.mission_evidence_dir = nodePath.relative(process.cwd(), evidenceDir) || evidenceDir;
    }
  }
  const mergedContext = { ...baseContext, ...autoContext, ...overrideContext };

  logger.info(`🚀 [PIPELINE] Running ADF pipeline: ${pipeline.name || argv.input}`);

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
