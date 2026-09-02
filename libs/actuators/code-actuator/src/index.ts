import { logger } from '@agent/core/core';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { isDirectEntry } from '@agent/core/direct-entry';
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

if (isDirectEntry(import.meta.url, 'libs/actuators/code-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}

export { handleAction };

export { describeOps } from './op-catalog.js';
