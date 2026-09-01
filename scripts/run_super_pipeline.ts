import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { isBuiltinPipelineResource } from '@agent/core/trust-requiring-resources';
import { finalizeAndPersist, TraceContext } from '@agent/core/src/trace';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as superNerve from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';
import type { SuperPipelineStep } from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export async function main(
  args: string[] = []
): Promise<Awaited<ReturnType<typeof superNerve.executeSuperPipeline>>> {
  const argv = await createStandardYargs(['node', 'run_super_pipeline', ...args])
    .option('input', { alias: 'i', type: 'string', required: true })
    .option('project-trust-approval', {
      type: 'string',
      describe: 'Approved project-trust request id for this exact pipeline resource',
    })
    .parseSync(args);

  const inputPath = assertSafeRepositoryPath(
    path.isAbsolute(String(argv.input))
      ? String(argv.input)
      : pathResolver.resolve(String(argv.input))
  );
  const projectTrustApprovalId = argv['project-trust-approval']
    ? String(argv['project-trust-approval']).trim() || undefined
    : undefined;
  const trustResolved =
    isBuiltinPipelineResource(pathResolver.toRepoRelative(inputPath)) && !projectTrustApprovalId;
  const inputData = (await readValidatedWorkflowAdf(inputPath, {
    trustResolved,
    projectTrustApprovalId,
  })) as {
    steps: SuperPipelineStep[];
    context?: any;
    options?: any;
  };

  logger.info(`🧠 [SUPER_NERVE] Initiating cross-actuator pipeline from: ${argv.input}`);
  const pipelineId = path.basename(String(argv.input), path.extname(String(argv.input)));
  const trace = new TraceContext(`super-pipeline:${pipelineId}`, { pipelineId });

  try {
    const result = await superNerve.executeSuperPipeline(
      inputData.steps.map((step) => ({ ...step, params: step.params || {} })),
      inputData.context || {},
      {
        ...(inputData.options || {}),
        pipelinePath: inputPath,
        trustResolved,
        projectTrustApprovalId,
      }
    );
    trace.addEvent('super_pipeline.completed', { status: result.status });
    const persisted = finalizeAndPersist(trace);
    logger.info(
      `   [SUPER_NERVE] Trace: ${path.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
    );
    return result;
  } catch (err: any) {
    const message = err?.message ?? String(err);
    trace.addEvent('super_pipeline.failed', { error: message });
    const persisted = finalizeAndPersist(trace);
    logger.info(
      `   [SUPER_NERVE] Trace: ${path.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
    );
    throw new ScriptExitError(1, `❌ [SUPER_NERVE] Pipeline failed: ${message}`);
  }
}

export const runSuperPipeline = defineScript({
  name: 'pipeline:super',
  flags: [],
  run: async (context) => {
    const result = await main(context.argv);
    context.print(result);
    if (result.status !== 'succeeded') {
      throw new ScriptExitError(1, '❌ [SUPER_NERVE] Pipeline failed.');
    }
    context.print('✅ [SUPER_NERVE] Pipeline completed successfully.');
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'run_super_pipeline.ts') ||
  isDirectScript(import.meta.url, 'run_super_pipeline.js')
)
  void runSuperPipeline();
