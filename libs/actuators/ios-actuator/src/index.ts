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
import { runActuatorCli } from '@agent/core';

async function handleAction(input: IOSAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}`);
  }
  return executePipeline(input.steps || [], input.options || {}, input.context || {});
}

const main = async () => {
  await runActuatorCli({
    name: 'ios-actuator',
    handleAction,
  });
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
