import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { harvestRepository } from './lib.js';

const argv = createStandardYargs().option('repo', {
  alias: 'r',
  type: 'string',
  demandOption: true,
  description: 'Git repository URL',
}).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('knowledge-harvester', async () => {
    return await harvestRepository(argv.repo as string);
  });
}
