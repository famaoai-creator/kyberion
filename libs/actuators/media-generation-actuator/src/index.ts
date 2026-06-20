import { logger } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeReadFile, pathResolver } from '@agent/core';
import { handleAction } from './media-generation-action-helpers.js';

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string);
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

const isMain = process.argv[1] && (
  process.argv[1].endsWith('media-generation-actuator/src/index.ts') ||
  process.argv[1].endsWith('media-generation-actuator/dist/index.js') ||
  process.argv[1].endsWith('media-generation-actuator/src/index.js')
);

if (isMain) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
