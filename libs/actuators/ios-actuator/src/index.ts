import { isDirectEntry } from '@agent/core/direct-entry';
import {
  buildRetryOptions,
  DEFAULT_IOS_RETRY,
  executePipeline,
  type IOSAction,
  type PipelineStep,
} from './ios-runtime-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

async function handleAction(input: IOSAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}`);
  }
  return executePipeline(input.steps || [], input.options || {}, input.context || {});
}

const main = async () => {
  await runActuatorCli({
    name: 'ios-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/ios-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'ios-actuator');
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
