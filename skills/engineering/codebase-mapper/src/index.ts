import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkillAsync } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { buildTreeLinesAsync } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Root directory to map',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for JSON map',
  })
  .option('depth', {
    alias: 'd',
    type: 'number',
    default: 3,
    description: 'Max tree depth',
  })
  .help()
  .parseSync();

runSkillAsync('codebase-mapper', async () => {
  const rootDir = path.resolve(argv.input as string);
  if (rootDir === '/') throw new Error('Refusing to map root directory /');

  const tree = await buildTreeLinesAsync(rootDir, argv.depth as number);
  const result = { root: rootDir, tree };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
