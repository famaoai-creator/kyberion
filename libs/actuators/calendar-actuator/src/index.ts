import { logger, safeReadFile, createStandardYargs, pathResolver, classifyError, formatClassification } from '@agent/core';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { handleAction } from './calendar-actuator-helpers.js';

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .parseSync();
  const inputPath = pathResolver.rootResolve(argv.input as string);
  const inputContent = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string);
  const result = await handleAction(inputContent);
  console.log(JSON.stringify(result, null, 2));
};

const isDirectRun = process.env.NODE_ENV !== 'test';
const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (isDirectRun || entrypoint === modulePath) {
  main().catch(err => {
    logger.error(formatClassification(classifyError(err)));
    process.exit(1);
  });
}

export { handleAction, listCalendars, listEvents, createEvent } from './calendar-actuator-helpers.js';

