import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { loadRules, classifyIntent } from './lib.js';

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
  })
  .parseSync();

// In Node16 with CommonJS output, __dirname is still available
const rulesPath = path.resolve(__dirname, '../../../knowledge/classifiers/intent-rules.yml');

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('intent-classifier', () => {
    const rules = loadRules(rulesPath);
    return classifyIntent(argv.input as string, rules);
  });
}
