import { logger, safeExec, resolveVars, evaluateCondition } from '@agent/core';
import { rootResolve } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { derivePipelineStatus, type PipelineAdfStep, validatePipelineAdf } from '@agent/core/pipeline-contract';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  for (const step of steps) {
    try {
      const normalizedOp = normalizePipelineOp(step.op);
      const [domain, action] = normalizedOp.split(':');
      const params = (step.params || {}) as Record<string, unknown>;

      if (domain === 'system' && action === 'log') {
        logger.info(resolveLogMessage(params, ctx));
      } else if (domain === 'system' && action === 'shell') {
        const cmd = String(resolveVars(params.cmd || '', ctx));
        const output = safeExec('zsh', ['-lc', cmd], { cwd: process.cwd() }).trim();
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
    .parseSync();

  const inputPath = rootResolve(argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const pipeline = validatePipelineAdf(JSON.parse(inputContent));

  logger.info(`🚀 [PIPELINE] Running ADF pipeline: ${pipeline.name || argv.input}`);
  
  try {
    const result = await runSteps(
      (pipeline.steps || []).map((step) => ({ ...step, params: step.params || {} })),
      (pipeline.context || {}) as Record<string, unknown>
    );
    if (result.status === 'succeeded') {
      logger.success(`✅ [PIPELINE] Completed: ${pipeline.name || argv.input}`);
    } else {
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
