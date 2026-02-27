import * as fs from 'node:fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath, readJsonFile } from '@agent/core/validators';
import { safeWriteFile } from '@agent/core/secure-io';
import { renderTemplate } from './lib.js';

const argv = createStandardYargs()
  .option('template', { alias: 't', type: 'string', demandOption: true })
  .option('data', { alias: 'd', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('template-renderer', () => {
    const templatePath = validateFilePath(argv.template as string, 'template');
    const template = safeReadFile(templatePath, 'utf8');
    const data = readJsonFile(argv.data as string, 'template data');

    const output = renderTemplate(template, data);

    if (argv.out) {
      safeWriteFile(argv.out as string, output);
      return { output: argv.out, size: output.length };
    } else {
      return { content: output };
    }
  });
}
