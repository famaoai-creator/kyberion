import { logger, safeReadFile, pathResolver, withRetry } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  buildRetryOptions,
  executePipeline,
  performReconcile,
  type ModelingAction,
} from './modeling-pipeline-helpers.js';

/**
 * Main Entry Point
 */
export async function handleAction(input: ModelingAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

/**
 * CLI Runner
 */
const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputContent = await withRetry(
    async () => safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string,
    buildRetryOptions(),
  );
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
