import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './agent-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

export const actuator = defineCatalogBackedActuator({
  id: 'agent-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'agent-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/agent-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'agent-actuator');
}

export { handleAction };
