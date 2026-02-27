import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { checkOversizedInstances, calculateWasteScore } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Directory with cloud configs',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for waste report',
  })
  .help()
  .parseSync();

runSkill('cloud-waste-hunter', () => {
  const scanDir = path.resolve(argv.input as string);
  if (!fs.existsSync(scanDir)) throw new Error('Directory not found: ' + scanDir);

  const allFiles = getAllFiles(scanDir, { maxDepth: 10 });
  const findings: any[] = [];

  for (const filePath of allFiles) {
    if (!filePath.endsWith('.tf') && !filePath.endsWith('.yaml') && !filePath.endsWith('.yml'))
      continue;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      findings.push(...checkOversizedInstances(content, path.relative(scanDir, filePath)));
    } catch {}
  }

  const result = {
    findings,
    totalFiles: allFiles.length,
    wasteScore: calculateWasteScore(findings),
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
