import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { scanCryptoContent } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Directory to scan for crypto usage',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for report',
  })
  .help()
  .parseSync();

runSkill('post-quantum-shield', () => {
  const targetDir = path.resolve(argv.input as string);
  if (!fs.existsSync(targetDir)) throw new Error('Directory not found: ' + targetDir);

  const allFiles = getAllFiles(targetDir, { maxDepth: 3 });
  const results: any[] = [];

  for (const f of allFiles) {
    if (['.js', '.ts', '.py'].includes(path.extname(f))) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        results.push(...scanCryptoContent(content, path.relative(targetDir, f)));
      } catch {}
    }
  }

  const result = { directory: targetDir, findings: results };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
