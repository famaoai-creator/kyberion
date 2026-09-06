import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './media-generation-action-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

const main = async () => {
  await runActuatorCli({
    name: 'media-generation-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/media-generation-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'media-generation-actuator');
}

export { handleAction };

export const actuator = defineCatalogBackedActuator({
  id: 'media-generation-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
