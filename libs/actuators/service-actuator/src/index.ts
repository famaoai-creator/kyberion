import { logger } from '@agent/core/core';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { handleAction } from './service-actuator-helpers.js';
import { runActuatorCli } from '@agent/core/cli-utils';

// Slack streaming ingress belongs to the Slack gateway.

const main = async () => {
  await runActuatorCli({
    name: 'service-actuator',
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
  id: 'service-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as unknown as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
