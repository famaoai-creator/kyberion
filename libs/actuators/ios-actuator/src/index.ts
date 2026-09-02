import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import {
  buildRetryOptions,
  DEFAULT_IOS_RETRY,
  executePipeline,
  type IOSAction,
  type PipelineStep,
} from './ios-runtime-helpers.js';
import { runActuatorCli } from '@agent/core/cli-utils';

async function handleAction(input: IOSAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}`);
  }
  return executePipeline(input.steps || [], input.options || {}, input.context || {});
}

const main = async () => {
  await runActuatorCli({
    name: 'ios-actuator',
    args: process.argv,
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/ios-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}

export { handleAction, buildRetryOptions, DEFAULT_IOS_RETRY };
export type { IOSAction, PipelineStep };

export const actuator = defineCatalogBackedActuator({
  id: 'ios-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
