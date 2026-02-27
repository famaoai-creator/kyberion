import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { analyzeBinaryFile } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Binary file or directory to scan',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for forensic report',
  })
  .help()
  .parseSync();

runSkill('binary-archaeologist', () => {
  const target = path.resolve(argv.input as string);
  if (!fs.existsSync(target)) throw new Error(`Target not found: ${target}`);

  const results: any[] = [];

  if (fs.statSync(target).isDirectory()) {
    const allFiles = getAllFiles(target, { maxDepth: 5 });
    for (const f of allFiles) {
      // Basic heuristic for binary: not markdown, json, ts, etc.
      if (!f.match(/\.(ts|js|json|md|txt|yaml|yml|tf|sh|cjs|mjs)$/)) {
        try {
          results.push({ file: path.relative(target, f), ...analyzeBinaryFile(f) });
        } catch {}
      }
    }
  } else {
    results.push({ file: path.basename(target), ...analyzeBinaryFile(target) });
  }

  const output = { target, results, timestamp: new Date().toISOString() };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(output, null, 2));
  }

  return output;
});
