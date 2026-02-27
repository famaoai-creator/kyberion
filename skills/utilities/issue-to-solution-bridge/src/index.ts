import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { analyzeIssue } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Description of the issue or feature request',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for implementation ticket',
  })
  .help()
  .parseSync();

runSkill('issue-to-solution-bridge', () => {
  const title = argv.input as string;
  const body = argv.input as string;

  const analysis = analyzeIssue(title, body);

  const result = {
    issue: 'custom',
    title,
    analysis,
    timestamp: new Date().toISOString(),
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
