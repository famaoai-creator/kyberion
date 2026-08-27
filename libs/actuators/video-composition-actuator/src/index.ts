import { logger } from '@agent/core';
import {
  handleAction,
  dispatchVideoCompositionOperation,
} from './video-composition-action-helpers.js';
import { runActuatorCli } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const main = async () => {
  await runActuatorCli({
    name: 'video-composition-actuator',
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

export { handleAction, dispatchVideoCompositionOperation };

export const actuator = defineCatalogBackedActuator({
  id: 'video-composition-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
