import { logger } from '@agent/core/core';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { handleAction } from './code-pipeline-helpers.js';
import { runActuatorCli } from '@agent/core/cli-utils';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'code-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'code-actuator',
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

export { describeOps } from './op-catalog.js';
