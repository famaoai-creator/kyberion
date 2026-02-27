import { runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import { checkGoogleAuth, draftEmail } from './lib.js';

const argv = createStandardYargs()
  .option('action', {
    alias: 'a',
    type: 'string',
    default: 'status',
    choices: ['status', 'draft-email', 'list-events'],
  })
  .option('input', { alias: 'i', type: 'string' })
  .option('to', { alias: 't', type: 'string' })
  .option('dry-run', { type: 'boolean', default: true })
  .option('out', { alias: 'o', type: 'string' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('google-workspace-integrator', async () => {
    const rootDir = pathResolver.rootDir();
    const auth = checkGoogleAuth(rootDir);
    const isDryRun = argv['dry-run'];
    let actionResult: any;

    switch (argv.action) {
      case 'draft-email':
        actionResult = draftEmail(argv.input as string, argv.to as string);
        break;
      case 'list-events':
        actionResult = isDryRun
          ? [{ summary: 'Mock Event', start: new Date().toISOString() }]
          : { message: 'Live mode not fully implemented in TS yet' };
        break;
      default:
        actionResult = { message: 'Google Workspace connection ready' };
    }

    const result = {
      action: argv.action,
      mode: isDryRun ? 'dry-run' : 'live',
      authStatus: auth.configured ? 'configured' : 'not_configured',
      result: actionResult,
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
