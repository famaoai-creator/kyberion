import * as path from 'node:path';
import { finalizeAndPersist, logger, TraceContext, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as superNerve from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';
import type { SuperPipelineStep } from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';
import { readValidatedPipelineAdf } from './refactor/adf-input.js';

async function main() {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = readValidatedPipelineAdf(argv.input as string) as { steps: SuperPipelineStep[], context?: any, options?: any };

  logger.info(`🧠 [SUPER_NERVE] Initiating cross-actuator pipeline from: ${argv.input}`);
  const pipelineId = path.basename(String(argv.input), path.extname(String(argv.input)));
  const trace = new TraceContext(`super-pipeline:${pipelineId}`, { pipelineId });
  
  try {
    const result = await superNerve.executeSuperPipeline(
      inputData.steps.map((step) => ({ ...step, params: step.params || {} })),
      inputData.context || {},
      inputData.options || {}
    );
    trace.addEvent('super_pipeline.completed', { status: result.status });
    const persisted = finalizeAndPersist(trace);
    logger.info(`   [SUPER_NERVE] Trace: ${path.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'succeeded') {
      logger.error('❌ [SUPER_NERVE] Pipeline failed.');
      process.exit(1);
    }
    logger.success('✅ [SUPER_NERVE] Pipeline completed successfully.');
  } catch (err: any) {
    trace.addEvent('super_pipeline.failed', { error: err.message });
    const persisted = finalizeAndPersist(trace);
    logger.info(`   [SUPER_NERVE] Trace: ${path.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`);
    logger.error(`❌ [SUPER_NERVE] Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main();
