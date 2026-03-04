import { runSkillAsync } from '@agent/core';
import { getGoogleAuth, fetchAgenda, formatAgenda, listEmails, sendEmail, exchangeCodeForToken } from './lib.js';
import { logger } from '@agent/core/core';
import { safeWriteFile } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import * as path from 'node:path';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

/**
 * Skill: Google Workspace Integrator
 *
 * Integrates with Google Calendar and Gmail APIs.
 */

runSkillAsync('google-workspace-integrator', async () => {
  const argv = await yargs(hideBin(process.argv))
    .option('action', {
      alias: 'a',
      description: 'Action to perform (agenda, emails, send, auth)',
      type: 'string',
      demandOption: true,
    })
    .option('out', {
      alias: 'o',
      description: 'Output file path',
      type: 'string',
    }).argv;

  const { action, out } = argv;
  const auth = await getGoogleAuth();

  if (action === 'auth') {
    console.log('Authentication successful.');
    return;
  }

  let result: any;
  if (action === 'agenda') {
    result = await fetchAgenda(auth);
    result = formatAgenda(result);
  } else if (action === 'emails') {
    result = await listEmails(auth);
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  if (out) {
    safeWriteFile(out, JSON.stringify(result, null, 2));
    logger.success(`Results saved to ${out}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
});
