import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './service-actuator-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

// Slack streaming ingress belongs to the Slack gateway.

const main = async () => {
  await runActuatorCli({
    name: 'service-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/service-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'service-actuator');
}

export { handleAction };

export const actuator = defineCatalogBackedActuator({
  id: 'service-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as unknown as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
