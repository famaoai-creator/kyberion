import { logger, safeExistsSync, safeReadFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { resolveAndExecuteIntent } from '../libs/actuators/orchestrator-actuator/src/super-nerve/resolver.js';

async function main() {
  const argv = await createStandardYargs()
    .option('intent', { alias: 'n', type: 'string', description: 'Semantic intent ID or keyword' })
    .option('input', { alias: 'i', type: 'string', description: 'Context ADF path' })
    .parseSync();

  const intent = argv.intent || argv._[0] as string;
  if (!intent) {
    logger.error('Usage: node dist/scripts/run_intent.js <intent_id> [--input context.json]');
    process.exit(1);
  }

  let context = {};
  if (argv.input && safeExistsSync(path.resolve(process.cwd(), argv.input))) {
    context = JSON.parse(safeReadFile(path.resolve(process.cwd(), argv.input), { encoding: 'utf8' }) as string);
  }

  logger.info(`🚀 [GATEWAY] Processing high-level intent: ${intent}`);
  
  try {
    const result = await resolveAndExecuteIntent(intent, context);
    console.log(JSON.stringify(result, null, 2));
    logger.success(`✅ [GATEWAY] Goal achieved for intent: ${intent}`);
  } catch (err: any) {
    logger.error(`❌ [GATEWAY] Failed to achieve goal: ${err.message}`);
    process.exit(1);
  }
}

main();
