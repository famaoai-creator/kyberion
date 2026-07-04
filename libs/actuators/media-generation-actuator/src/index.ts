import { logger } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeReadFile, pathResolver } from '@agent/core';
import { handleAction } from './media-generation-action-helpers.js';
import { runActuatorCli } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const main = async () => {
  await runActuatorCli({
    name: 'media-generation-actuator',
    handleAction,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
