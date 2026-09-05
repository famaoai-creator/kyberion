import { isDirectEntry } from '@agent/core/direct-entry';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleAction } from './secret-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

export const actuator = defineCatalogBackedActuator({
  id: 'secret-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'secret-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/secret-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'secret-actuator');
}

export { handleAction };
