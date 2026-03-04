import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import * as fs from 'node:fs';
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
    const content = safeReadFile(inputPath, { encoding: 'utf8' }) as string;

    let requiredKeywords: string[] = [];
    if (argv.criteria) {
      const criteria = readJsonFile(argv.criteria as string, 'criteria') as any;
      if (Array.isArray(criteria.required)) {
        requiredKeywords = criteria.required;
      }
    }

    return scoreCompleteness(content, requiredKeywords);
  });
}
