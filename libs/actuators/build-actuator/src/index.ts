import { isDirectEntry } from '@agent/core/direct-entry';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleAction } from './build-actuator-helpers.js';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'build-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'build-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/build-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'build-actuator');
}

export {
  handleAction,
  buildCommandForOp,
  extractErrorSummary,
  scaffoldApp,
  type BuildActuatorInput,
  type BuildActuatorResult,
  type BuildOp,
} from './build-actuator-helpers.js';
