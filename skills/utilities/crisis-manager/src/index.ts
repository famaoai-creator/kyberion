import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { analyzeLogLines } from './lib.js';

const argv = createStandardYargs().option('log', {
  alias: 'l',
  type: 'string',
  demandOption: true,
}).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('crisis-manager', () => {
    const logPath = path.resolve(argv.log as string);
    if (!fs.existsSync(logPath)) throw new Error('Log not found');

    const nl = String.fromCharCode(10);
    const lines = fs.readFileSync(logPath, 'utf8').split(nl);
    const analysis = analyzeLogLines(lines);

    return { status: 'analyzed', analysis };
  });
}
