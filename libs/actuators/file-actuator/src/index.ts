import { logger, defineCatalogBackedActuator } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAction } from './file-pipeline-helpers.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core';

export const actuator = defineCatalogBackedActuator({
  id: 'file-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'file-actuator',
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

export { describeOps } from './op-catalog.js';
