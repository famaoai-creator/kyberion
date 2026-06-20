import { logger, safeReadFile, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  buildRetryOptions,
  DEFAULT_IOS_RETRY,
  executePipeline,
  type IOSAction,
  type PipelineStep,
} from './ios-runtime-helpers.js';

async function handleAction(input: IOSAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}`);
  }
  return executePipeline(input.steps || [], input.options || {}, input.context || {});
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputPath = path.resolve(pathResolver.rootDir(), argv.input as string);
  const content = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(content));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction, buildRetryOptions, DEFAULT_IOS_RETRY, executePipeline };
export type { IOSAction, PipelineStep };
