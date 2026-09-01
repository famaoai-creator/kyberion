import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { runActuatorCli } from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleAction } from './build-actuator-helpers.js';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'build-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'build-actuator',
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

export {
  handleAction,
  buildCommandForOp,
  extractErrorSummary,
  scaffoldApp,
  type BuildActuatorInput,
  type BuildActuatorResult,
  type BuildOp,
} from './build-actuator-helpers.js';
