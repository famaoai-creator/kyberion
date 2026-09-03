import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './meeting-actuator-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

const main = async () => {
  await runActuatorCli({
    name: 'meeting-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/meeting-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'meeting-actuator');
}

export { handleAction };

export const actuator = defineCatalogBackedActuator({
  id: 'meeting-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
