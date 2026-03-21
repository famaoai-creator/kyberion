import { logger, safeReadFile, executeServicePreset } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';

/**
 * Voice-Actuator v1.1.0 [THIN CLIENT]
 * Proxies voice generation requests to the Adaptive Service Engine.
 */

async function handleSingleAction(input: any) {
  const { action, params } = input;
  logger.info(`🔊 [VOICE:PROXY] Dispatching "${action}" to Service Engine...`);

  // Delegate everything to the 'voice' service preset
  return await executeServicePreset('voice', action, params);
}

export async function handleAction(input: any) {
  if (input.action === 'pipeline') {
    const results = [];
    for (const step of input.steps) {
      results.push(await handleSingleAction(step));
    }
    return { status: 'succeeded', results };
  }
  return await handleSingleAction(input);
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string);
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

const isMain = process.argv[1] && (
  process.argv[1].endsWith('voice-actuator/src/index.ts') || 
  process.argv[1].endsWith('voice-actuator/dist/index.js') ||
  process.argv[1].endsWith('voice-actuator/src/index.js')
);

if (isMain) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
