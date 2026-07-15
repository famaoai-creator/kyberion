import { runActuatorCli, safeReadFile, pathResolver } from '@agent/core';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { handleAction } from './process-actuator-helpers.js';

async function main() {
  const processActionSchema = JSON.parse(
    String(
      safeReadFile(pathResolver.rootResolve('schemas/process-action.schema.json'), {
        encoding: 'utf8',
      })
    )
  );
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
