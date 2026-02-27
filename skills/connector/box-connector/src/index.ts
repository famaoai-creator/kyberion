import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { checkBoxConfig, simulateBoxAction } from './lib.js';

const argv = createStandardYargs()
  .option('action', {
    alias: 'a',
    type: 'string',
    default: 'status',
    choices: ['status', 'list', 'download', 'search'],
  })
  .option('folder', { alias: 'f', type: 'string', default: '0' })
  .option('query', { alias: 'q', type: 'string' })
  .option('config', { alias: 'c', type: 'string' })
  .option('dry-run', { type: 'boolean', default: true })
  .option('out', { alias: 'o', type: 'string' }).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('box-connector', () => {
    const config = checkBoxConfig(argv.config as string);
    const isDryRun = argv['dry-run'];

    if (!isDryRun && !config.found) {
      throw new Error('Box config not found.');
    }

    const actionResult = simulateBoxAction(
      argv.action as string,
      argv.folder as string,
      argv.query as string
    );
    const result = {
      action: argv.action,
      mode: isDryRun ? 'dry-run' : 'live',
      configStatus: config.found ? 'found' : 'not_configured',
      result: actionResult,
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
