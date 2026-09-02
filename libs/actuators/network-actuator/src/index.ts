import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleAction } from './network-pipeline-helpers.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core/cli-utils';

export const actuator = defineCatalogBackedActuator({
  id: 'network-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'network-actuator',
    args: process.argv,
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/network-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}

export { handleAction };

export { describeOps } from './op-catalog.js';
