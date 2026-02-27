import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { staticAnalysis } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Directory to scan for vulnerabilities',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for report',
  })
  .help()
  .parseSync();

runSkill('red-team-adversary', () => {
  const targetDir = path.resolve(argv.input as string);
  if (!fs.existsSync(targetDir)) throw new Error('Directory not found: ' + targetDir);

  const allFiles = getAllFiles(targetDir, { maxDepth: 3 });
  const vulnerabilities: any[] = [];

  for (const f of allFiles) {
    if (['.js', '.ts'].includes(path.extname(f))) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        vulnerabilities.push(...staticAnalysis(content, path.relative(targetDir, f)));
      } catch {}
    }
  }

  const result = { directory: targetDir, vulnerabilities };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
