import { logger } from '@agent/core/core';
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
  
  try {
    const result = await superNerve.executeSuperPipeline(
      inputData.steps.map((step) => ({ ...step, params: step.params || {} })),
      inputData.context || {},
      inputData.options || {}
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'succeeded') {
      logger.error('❌ [SUPER_NERVE] Pipeline failed.');
      process.exit(1);
    }
    logger.success('✅ [SUPER_NERVE] Pipeline completed successfully.');
  } catch (err: any) {
    logger.error(`❌ [SUPER_NERVE] Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main();
