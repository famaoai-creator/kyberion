import * as path from 'path';
import * as fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { scanProject } from './lib.js';
import { safeWriteFile } from '@agent/core/secure-io';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Project directory to scan',
  })
  .option('out', { alias: 'o', type: 'string' })
  .help()
  .parseSync();

runSkill('security-scanner', () => {
  const projectRoot = path.resolve((argv.input as string) || '.');
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Directory not found: ${projectRoot}`);
  }

  const result = scanProject(projectRoot);

  const output = {
    projectRoot,
    ...result,
    findingCount: result.findings.length,
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(output, null, 2));
  }

  return output;
});
