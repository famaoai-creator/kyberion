import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import * as fs from 'node:fs';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath } from '@agent/core/validators';
import { generateDiff } from './lib.js';

const argv = createStandardYargs()
  .option('old', { alias: 'a', type: 'string', demandOption: true })
  .option('new', { alias: 'b', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('diff-visualizer', () => {
    const oldPath = validateFilePath(argv.old as string, 'old file');
    const newPath = validateFilePath(argv.new as string, 'new file');
    const oldText = safeReadFile(oldPath, { encoding: 'utf8' }) as string;
    const newText = safeReadFile(newPath, { encoding: 'utf8' }) as string;

    const diff = generateDiff(argv.old as string, argv.new as string, oldText, newText);

    if (argv.out) {
      safeWriteFile(argv.out as string, diff);
      return { output: argv.out, size: diff.length };
    } else {
      return { content: diff };
    }
  });
}
