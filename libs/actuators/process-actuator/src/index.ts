import { runActuatorCli } from '@agent/core';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { handleAction } from './process-actuator-helpers.js';
import processActionSchema from '../../../../schemas/process-action.schema.json';

async function main() {
  await runActuatorCli({
    name: 'process-actuator',
    handleAction,
    schema: processActionSchema,
  });
}

export { handleAction };

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    console.error(`[process-actuator] ${err?.message || err}`);
    process.exit(1);
  });
}
