import { logger } from '@agent/core';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAction } from './terminal-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core';

export const actuator = defineCatalogBackedActuator({
  id: 'terminal-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'terminal-actuator',
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
