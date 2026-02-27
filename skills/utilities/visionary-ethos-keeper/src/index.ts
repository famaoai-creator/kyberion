import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { analyzeAlignment } from './lib.js';

const argv = createStandardYargs().option('input', {
  alias: 'i',
  type: 'string',
  demandOption: true,
}).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('visionary-ethos-keeper', () => {
    const inputPath = path.resolve(argv.input as string);
    const content = safeReadFile(inputPath, 'utf8');

    const values = [
      { name: 'User First', keywords: ['user', 'ux'] },
      { name: 'Innovation', keywords: ['new', 'modern'] },
    ];

    const alignment = analyzeAlignment(content, values);
    return { overallScore: alignment.filter((a) => a.score > 0).length, alignment };
  });
}
