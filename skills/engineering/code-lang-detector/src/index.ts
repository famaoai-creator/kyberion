import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { detectLanguage } from './lib.js';

const argv = createStandardYargs().option('input', { alias: 'i', type: 'string' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('code-lang-detector', () => {
    const input = (argv.input as string) || '';

    let content = '';
    // If input string looks like a file path and exists, read it
    // Otherwise treat the input string as the content itself
    if (input && input.length < 255 && fs.existsSync(input)) {
      content = safeReadFile(input, 'utf8');
    } else {
      content = input;
    }

    return detectLanguage(input, content);
  });
}
