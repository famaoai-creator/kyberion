import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath } from '@agent/core/validators';
import { scanContent } from './lib.js';

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
  })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('sensitivity-detector', () => {
    const inputPath = validateFilePath(argv.input as string, 'input');
    const content = safeReadFile(inputPath, 'utf8');
    return scanContent(content);
  });
}
