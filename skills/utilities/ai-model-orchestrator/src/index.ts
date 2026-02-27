import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { analyzeTaskComplexity, selectModel, AIModel } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('budget', {
    alias: 'b',
    type: 'string',
    default: 'balanced',
    choices: ['economy', 'balanced', 'premium'],
  })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('ai-model-orchestrator', () => {
    const inputPath = path.resolve(argv.input as string);
    if (!fs.existsSync(inputPath)) throw new Error('Input not found');

    const content = safeReadFile(inputPath, 'utf8');
    const complexity = analyzeTaskComplexity(content);
    const model = selectModel(complexity, argv.budget as any);

    const result = {
      selectedModel: model.id,
      complexity: complexity.hardness,
      estimatedCost: model.costPer1kTokens * (complexity.estimatedTokens / 1000),
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
