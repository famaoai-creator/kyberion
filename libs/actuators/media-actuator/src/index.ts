import { logger } from '@agent/core';
import { handleMediaAction, type MediaAction } from './media-pipeline-helpers.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runActuatorCli } from '@agent/core';
import { opCapture } from './media-action-capture.js';
import { opTransform } from './media-action-transform.js';
import { opApply } from './media-action-apply.js';

async function handleAction(input: MediaAction) {
  return handleMediaAction(input, {
    opCapture,
    opTransform,
    opApply,
  });
}

const main = async () => {
  await runActuatorCli({
    name: 'media-actuator',
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

export const actuator = defineCatalogBackedActuator({
  id: 'media-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
