import { isDirectEntry } from '@agent/core/direct-entry';
import {
  handleAction,
  dispatchVideoCompositionOperation,
} from './video-composition-action-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

const main = async () => {
  await runActuatorCli({
    name: 'video-composition-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/video-composition-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'video-composition-actuator');
}

export { handleAction, dispatchVideoCompositionOperation };

export const actuator = defineCatalogBackedActuator({
  id: 'video-composition-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
