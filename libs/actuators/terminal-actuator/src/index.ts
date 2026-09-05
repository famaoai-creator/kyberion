import { isDirectEntry } from '@agent/core/direct-entry';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleAction } from './terminal-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

export const actuator = defineCatalogBackedActuator({
  id: 'terminal-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'terminal-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/terminal-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'terminal-actuator');
}

export { handleAction };
