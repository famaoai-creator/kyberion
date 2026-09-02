import { isDirectEntry } from '@agent/core/direct-entry';
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

if (isDirectEntry(import.meta.url, 'libs/actuators/build-actuator/src/index.ts')) {
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
