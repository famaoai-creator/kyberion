import { logger } from '@agent/core/core';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}
