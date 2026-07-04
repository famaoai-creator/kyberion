import { logger, createStandardYargs, pathResolver, safeReadFile } from '@agent/core';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { handleAction } from './agent-actuator-helpers.js';
import { runActuatorCli } from '@agent/core';

const main = async () => {
  await runActuatorCli({
    name: 'agent-actuator',
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
