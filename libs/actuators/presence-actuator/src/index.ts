import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './presence-actuator-helpers.js';
import { runActuatorCli } from '@agent/core/cli-utils';

const main = async () => {
  await runActuatorCli({
    name: 'presence-actuator',
    args: process.argv,
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/presence-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}

export { handleAction, MessagingMode } from './presence-actuator-helpers.js';

export const actuator = defineCatalogBackedActuator({
  id: 'presence-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as unknown as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
