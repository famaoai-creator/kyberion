import * as fs from 'node:fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath, readJsonFile } from '@agent/core/validators';
import { safeWriteFile } from '@agent/core/secure-io';
import { injectContext } from './lib.js';

const argv = createStandardYargs()
  .option('data', { alias: 'd', type: 'string', demandOption: true })
  .option('knowledge', { alias: 'k', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' })
  .option('output-tier', {
    type: 'string',
    default: 'public',
    choices: ['personal', 'confidential', 'public'],
  })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('context-injector', () => {
    const data = readJsonFile(argv.data as string, 'data');
    const knowledgePath = validateFilePath(argv.knowledge as string, 'knowledge');
    const outputTier = argv['output-tier'] as string;
    const knowledgeContent = fs.readFileSync(knowledgePath, 'utf8');

    const result = injectContext(data, knowledgeContent, knowledgePath, outputTier);

    const output = JSON.stringify(data, null, 2);
    if (argv.out) {
      safeWriteFile(argv.out as string, output);
    }

    return result;
  });
}
