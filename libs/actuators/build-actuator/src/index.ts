import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { logger, runActuatorCli } from '@agent/core';
import { handleAction } from './build-actuator-helpers.js';

const main = async () => {
  await runActuatorCli({
    name: 'build-actuator',
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

export {
  handleAction,
  buildCommandForOp,
  extractErrorSummary,
  scaffoldApp,
  type BuildActuatorInput,
  type BuildActuatorResult,
  type BuildOp,
} from './build-actuator-helpers.js';
