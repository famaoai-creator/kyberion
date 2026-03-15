import { logger, safeReadFile, validatePipelineAdf } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { executeSuperPipeline, SuperPipelineStep } from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';

async function main() {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const inputData = validatePipelineAdf(JSON.parse(inputContent)) as { steps: SuperPipelineStep[], context?: any, options?: any };

  logger.info(`🧠 [SUPER_NERVE] Initiating cross-actuator pipeline from: ${argv.input}`);
  
  try {
    const result = await executeSuperPipeline(
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
