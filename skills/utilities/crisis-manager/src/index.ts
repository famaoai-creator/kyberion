import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { analyzeLogLines, generateRCAReport } from './lib.js';

const argv = createStandardYargs()
  .option('log', {
    alias: 'l',
    type: 'string',
    demandOption: true,
  })
  .option('rca', {
    type: 'boolean',
    default: false,
    description: 'Generate professional RCA report using AI',
  })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('crisis-manager', async () => {
    const logPath = path.resolve(argv.log as string);
    if (!fs.existsSync(logPath)) throw new Error('Log not found');

    const logContent = safeReadFile(logPath, { encoding: 'utf8' }) as string;
    
    if (argv.rca) {
      const report = await generateRCAReport(logContent);
      if (argv.out) {
        safeWriteFile(path.resolve(argv.out as string), report);
      }
      return { status: 'rca_generated', report };
    }

    const nl = String.fromCharCode(10);
    const lines = logContent.split(nl);
    const analysis = analyzeLogLines(lines);

    return { status: 'analyzed', analysis };
  });
}
