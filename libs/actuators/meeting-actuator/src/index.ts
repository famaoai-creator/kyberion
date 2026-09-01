import { logger } from '@agent/core/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAction } from './meeting-actuator-helpers.js';
import { runActuatorCli } from '@agent/core/cli-utils';

const main = async () => {
  await runActuatorCli({
    name: 'meeting-actuator',
    args: process.argv,
    handleAction,
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

export { handleAction };

export const actuator = defineCatalogBackedActuator({
  id: 'meeting-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
