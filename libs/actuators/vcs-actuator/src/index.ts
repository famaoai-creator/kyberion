import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './vcs-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'vcs-actuator',
  describeOps,
  handleAction,
  actionInput: (op, params) => ({ op, params }),
});

const main = async () => {
  await runActuatorCli({
    name: 'vcs-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/vcs-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'vcs-actuator');
}

export { handleAction } from './vcs-helpers.js';
export type { VcsAction, VcsOp, VcsParams } from './vcs-helpers.js';
