import { runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import { sendSlackMessage, loadSlackCredentials } from './lib.js';

const argv = createStandardYargs()
  .option('action', {
    alias: 'a',
    type: 'string',
    default: 'message',
    choices: ['status', 'message', 'alert'],
  })
  .option('channel', { alias: 'c', type: 'string', default: '#general' })
  .option('thread_ts', { type: 'string', description: 'Parent thread timestamp for replies' })
  .option('input', { alias: 'i', type: 'string' })
  .option('dry-run', { type: 'boolean', default: false })
  .option('out', { alias: 'o', type: 'string' }).parseSync();

runSkillAsync('slack-communicator-pro', async () => {
  // 1. Argument Resolution (Command line + Optional Input File)
  let inputData: any = {};
  if (argv.input && argv.input.endsWith('.json')) {
    try {
      inputData = JSON.parse(safeReadFile(argv.input as string, { encoding: 'utf8' }) as string);
    } catch (_) {}
  }

  const action = (inputData.action || argv.action) as string;
  const channel = (inputData.channel || argv.channel) as string;
  const input = (inputData.input || argv.input) as string;
  const threadTs = (inputData.thread_ts || argv.thread_ts) as string;
  const dryRun = argv['dry-run'];

  if (action === 'status') {
    const creds = loadSlackCredentials();
    return { 
      status: 'ok', 
      configured: !!(creds.bot_token || creds.webhook_url),
      mode: creds.bot_token ? 'api' : 'webhook' 
    };
  }

  if (!input || input.endsWith('.json')) {
     // If input is still the filename or missing
     if (!inputData.input) throw new Error('Input message is required for sending');
  }

  const messageToSend = inputData.input || input;

  let messageResponse;
  if (!dryRun) {
    messageResponse = await sendSlackMessage(action, messageToSend, channel, threadTs);
  }

  const creds = loadSlackCredentials();
  const result = {
    status: dryRun ? 'dry-run' : 'sent',
    mode: creds.bot_token ? 'api' : 'webhook',
    channel,
    thread_ts: threadTs || (messageResponse ? messageResponse.ts : null),
    message: messageToSend,
  };

  if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  return result;
});
