import { logger, safeReadFile, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { executeSuperPipeline } from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';

async function main() {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = pathResolver.rootResolve(argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const pipeline = JSON.parse(inputContent);

  logger.info(`🚀 [PIPELINE] Running ADF pipeline: ${pipeline.name || argv.input}`);
  
  try {
    const result = await executeSuperPipeline(pipeline.steps || [], pipeline.context || {});
    if (result.status === 'finished') {
      logger.success(`✅ [PIPELINE] Completed: ${pipeline.name || argv.input}`);
    } else {
      logger.error(`❌ [PIPELINE] Failed: ${pipeline.name || argv.input}`);
    }
  } catch (err: any) {
    logger.error(`❌ [PIPELINE] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
