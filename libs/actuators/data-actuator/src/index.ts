import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './data-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'data-actuator',
  describeOps,
  handleAction,
  actionInput: (op, params) => ({ op, params }),
});

const main = async () => {
  await runActuatorCli({
    name: 'data-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/data-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'data-actuator');
}

export { handleAction } from './data-helpers.js';
export type { DataAction, DataRow } from './data-helpers.js';
