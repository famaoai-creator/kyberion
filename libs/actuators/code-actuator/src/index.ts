import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './code-pipeline-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'code-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'code-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/code-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'code-actuator');
}

export { handleAction };

export { describeOps } from './op-catalog.js';
