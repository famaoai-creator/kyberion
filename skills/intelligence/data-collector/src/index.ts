import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { collectData } from './lib.js';

const argv = createStandardYargs()
  .option('url', { alias: 'u', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string', demandOption: true })
  .option('name', { alias: 'n', type: 'string' })
  .option('force', { alias: 'f', type: 'boolean', default: false })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('data-collector', async () => {
    return await collectData(argv.url as string, argv.out as string, {
      name: argv.name as string,
      force: argv.force as boolean,
    });
  });
}
