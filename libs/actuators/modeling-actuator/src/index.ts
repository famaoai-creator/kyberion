import { logger, safeReadFile, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  buildRetryOptions,
  executePipeline,
  performReconcile,
  type ModelingAction,
} from './modeling-pipeline-helpers.js';
import { runActuatorCli } from '@agent/core';

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
  await runActuatorCli({
    name: 'modeling-actuator',
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

export { describeOps } from './op-catalog.js';
