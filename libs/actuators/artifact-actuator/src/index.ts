import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { isDirectEntry } from '@agent/core/direct-entry';
import { handleArtifactAction } from './artifact-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
export { handleArtifactAction as handleAction } from './artifact-actuator-helpers.js';

export const actuator = defineCatalogBackedActuator({
  id: 'artifact-actuator',
  describeOps,
  handleAction: handleArtifactAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'artifact-actuator',
    args: currentProcessArgv(),
    handleAction: handleArtifactAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/artifact-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'artifact-actuator');
}
