import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { checkSlackWebhook, formatSlackMessage } from './lib.js';

const argv = createStandardYargs()
  .option('action', {
    alias: 'a',
    type: 'string',
    default: 'status',
    choices: ['status', 'send', 'alert'],
  })
  .option('channel', { alias: 'c', type: 'string', default: '#general' })
  .option('input', { alias: 'i', type: 'string' })
  .option('dry-run', { type: 'boolean', default: true })
  .option('out', { alias: 'o', type: 'string' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('slack-communicator-pro', () => {
    const webhook = checkSlackWebhook();
    const message = formatSlackMessage(
      argv.action as string,
      argv.input as string,
      argv.channel as string
    );

    const result = {
      action: argv.action,
      channel: argv.channel,
      mode: argv['dry-run'] ? 'dry-run' : 'live',
      webhookStatus: webhook.configured ? 'configured' : 'not_configured',
      message,
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
