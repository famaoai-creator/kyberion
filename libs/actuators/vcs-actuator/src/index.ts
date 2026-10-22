import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction, handleStandaloneAction } from './vcs-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '@agent/core/actuator/actuator-sdk';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'vcs-actuator',
  describeOps,
  handleAction,
  actionInput: (op, params) => ({ op, params }),
});

const main = async () => {
  const args = currentProcessArgv();
  await runActuatorCli({
    name: 'vcs-actuator',
    args,
    handleAction: args.some((arg) => arg === '--serve' || arg === '--serve=true')
      ? handleAction
      : handleStandaloneAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/vcs-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'vcs-actuator');
}

export { handleAction, handleStandaloneAction } from './vcs-helpers.js';
export type { VcsAction, VcsOp, VcsParams } from './vcs-helpers.js';
