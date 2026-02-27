import * as fs from 'fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath, requireArgs } from '@agent/core/validators';
import { safeWriteFile } from '@agent/core/secure-io';
import { analyzeCode } from './lib.js';

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    describe: 'Path to source file to analyze',
  })
  .option('out', { alias: 'o', type: 'string', describe: 'Optional output file path' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('refactoring-engine', () => {
    requireArgs(argv, ['input']);
    const inputPath = validateFilePath(argv.input as string, 'input');
    const content = fs.readFileSync(inputPath, 'utf8');

    const result = analyzeCode(content, inputPath);

    if (argv.out) {
      safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    }

    return result;
  });
}
