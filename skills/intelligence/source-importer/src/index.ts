import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { importSource } from './lib.js';

const argv = createStandardYargs()
  .option('repo', { alias: 'r', type: 'string', description: 'Repository URL', demandOption: true })
  .option('name', { alias: 'n', type: 'string', description: 'Local name' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('source-importer', async () => {
    return await importSource(argv.repo as string, argv.name as string);
  });
}
