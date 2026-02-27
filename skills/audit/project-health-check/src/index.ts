import * as path from 'path';
import * as fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { performAudit } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Project root directory to audit',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for audit report',
  })
  .help()
  .parseSync();

runSkill('project-health-check', () => {
  const projectRoot = path.resolve(argv.input as string);
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Directory not found: ${projectRoot}`);
  }

  const result = performAudit(projectRoot);

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
