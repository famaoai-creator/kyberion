import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './android-runtime-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

const main = async () => {
  await runActuatorCli({
    name: 'android-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/android-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'android-actuator');
}

export { handleAction };

export const actuator = defineCatalogBackedActuator({
  id: 'android-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
