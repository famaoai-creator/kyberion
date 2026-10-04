import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './scheduler-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'scheduler-actuator',
  describeOps,
  handleAction,
  actionInput: (op, params) => ({ op, params }),
});

const main = async () => {
  await runActuatorCli({
    name: 'scheduler-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/scheduler-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'scheduler-actuator');
}

export {
  handleAction,
  listDeclarations,
  resolveStoreDir,
  validateCron,
} from './scheduler-helpers.js';
export type { ScheduleDeclaration, SchedulerAction } from './scheduler-helpers.js';
