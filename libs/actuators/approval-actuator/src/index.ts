import {
  createStandardYargs,
  logger,
  safeReadFile,
} from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver } from '@agent/core';
import { handleApprovalAction } from './approval-actuator-helpers.js';
export { handleApprovalAction as handleAction } from './approval-actuator-helpers.js';

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputPath = pathResolver.rootResolve(argv.input as string);
  const input = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string);
  const result = await handleApprovalAction(input);
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err: any) => {
    logger.error(err.message);
    process.exit(1);
  });
}
