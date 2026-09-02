import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import { handleMediaAction, type MediaAction } from './media-pipeline-helpers.js';
import { runActuatorCli } from '@agent/core/cli-utils';
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
    args: process.argv,
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/media-actuator/src/index.ts')) {
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
