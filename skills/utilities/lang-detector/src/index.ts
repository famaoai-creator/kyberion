import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import * as fs from 'node:fs';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath } from '@agent/core/validators';
import { detectLanguage } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('lang-detector', () => {
    const inputPath = validateFilePath(argv.input as string, 'input');
    const content = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
    return detectLanguage(content);
  });
}
