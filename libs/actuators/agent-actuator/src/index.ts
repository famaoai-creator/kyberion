import {
  logger,
  createStandardYargs,
  pathResolver,
  safeReadFile,
  defineCatalogBackedActuator,
} from '@agent/core';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { handleAction } from './agent-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core';

export const actuator = defineCatalogBackedActuator({
  id: 'agent-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'agent-actuator',
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
