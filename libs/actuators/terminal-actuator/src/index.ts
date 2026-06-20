import { logger, safeReadFile, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAction } from './terminal-actuator-helpers.js';

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  
  const inputPath = pathResolver.rootResolve(argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };

