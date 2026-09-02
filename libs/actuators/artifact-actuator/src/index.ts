import { logger } from '@agent/core/core';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { isDirectEntry } from '@agent/core/direct-entry';
import { handleArtifactAction } from './artifact-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core/cli-utils';
export { handleArtifactAction as handleAction } from './artifact-actuator-helpers.js';

export const actuator = defineCatalogBackedActuator({
  id: 'artifact-actuator',
  describeOps,
  handleAction: handleArtifactAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'artifact-actuator',
    args: process.argv,
    handleAction: handleArtifactAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/artifact-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}
