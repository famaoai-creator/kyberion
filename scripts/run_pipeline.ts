import { logger } from '../libs/core/core.js';
import { rootResolve } from '../libs/core/path-resolver.js';
import { safeReadFile } from '../libs/core/secure-io.js';
import { validatePipelineAdf } from '../libs/core/pipeline-contract.js';
import { createStandardYargs } from '../libs/core/cli-utils.js';
import { executeSuperPipeline } from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';

async function main() {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = rootResolve(argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const pipeline = validatePipelineAdf(JSON.parse(inputContent));

  logger.info(`🚀 [PIPELINE] Running ADF pipeline: ${pipeline.name || argv.input}`);
  
  try {
    const result = await executeSuperPipeline(
      (pipeline.steps || []).map((step) => ({ ...step, params: step.params || {} })),
      pipeline.context || {},
      pipeline.options || {}
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

main();
