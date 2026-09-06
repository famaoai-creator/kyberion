import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './file-pipeline-helpers.js';
import { describeOps } from './op-catalog.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

export const actuator = defineCatalogBackedActuator({
  id: 'file-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'file-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/file-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'file-actuator');
}

export { handleAction };

export { describeOps } from './op-catalog.js';
