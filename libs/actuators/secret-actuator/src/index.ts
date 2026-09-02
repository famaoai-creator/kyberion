import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleAction } from './secret-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core/cli-utils';

export const actuator = defineCatalogBackedActuator({
  id: 'secret-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'secret-actuator',
    args: process.argv,
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/secret-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}

export { handleAction };
