import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { loadRules, classifyIntent } from './lib.js';
import { pathResolver } from '@agent/core';

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
  })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('intent-classifier', () => {
    const rulesPath = path.join(pathResolver.rootDir(), 'knowledge/classifiers/intent-rules.yml');
    const rules = loadRules(rulesPath);
    return classifyIntent(argv.input as string, rules);
  });
}
