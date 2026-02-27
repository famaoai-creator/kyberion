import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { analyzeLogs } from './lib.js';

const argv = createStandardYargs().option('input', {
  alias: 'i',
  type: 'string',
  demandOption: true,
}).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('log-to-requirement-bridge', () => {
    const inputPath = path.resolve(argv.input as string);
    const content = safeReadFile(inputPath, 'utf8');
    const nl = String.fromCharCode(10);
    const lines = content.split(nl).filter((l) => l.trim().length > 0);

    const requirements = analyzeLogs(lines);
    return { source: path.basename(inputPath), suggestedRequirements: requirements };
  });
}
