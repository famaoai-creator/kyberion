import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath, readJsonFile } from '@agent/core/validators';
import { scoreCompleteness } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('criteria', {
    alias: 'c',
    type: 'string',
    description: 'JSON file with required keywords',
  })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('completeness-scorer', () => {
    const inputPath = validateFilePath(argv.input as string, 'input');
    const content = safeReadFile(inputPath, 'utf8');

    let requiredKeywords: string[] = [];
    if (argv.criteria) {
      const criteria = readJsonFile(argv.criteria as string, 'criteria');
      if (Array.isArray(criteria.required)) {
        requiredKeywords = criteria.required;
      }
    }

    return scoreCompleteness(content, requiredKeywords);
  });
}
