#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs'); const _path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('action', { alias: 'a', type: 'string', default: 'status', choices: ['status', 'send', 'summary', 'alert'], description: 'Action' })
  .option('channel', { alias: 'c', type: 'string', default: '#general', description: 'Slack channel' })
  .option('input', { alias: 'i', type: 'string', description: 'Input message or JSON file' })
  .option('dry-run', { type: 'boolean', default: true, description: 'Simulate without sending' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function checkWebhook() {
  const paths = ['knowledge/personal/slack-webhook.json', '.slack/webhook.json'];
  for (const p of paths) {
    if (fs.existsSync(p)) { try { return { configured: true, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch(_e){} }
  }
  return { configured: false };
}

function formatMessage(action, input, channel) {
  const message = { channel, blocks: [] };
  if (action === 'alert') {
    const data = input && fs.existsSync(input) ? JSON.parse(fs.readFileSync(input, 'utf8')) : { level: 'warning', message: input || 'Alert' };
    const emoji = data.level === 'critical' ? ':rotating_light:' : data.level === 'warning' ? ':warning:' : ':information_source:';
    message.blocks = [
      { type: 'header', text: { type: 'plain_text', text: `${emoji} ${data.level?.toUpperCase() || 'ALERT'}` } },
      { type: 'section', text: { type: 'mrkdwn', text: data.message || 'No details provided' } },
    ];
  } else if (action === 'summary') {
    const data = input && fs.existsSync(input) ? JSON.parse(fs.readFileSync(input, 'utf8')) : {};
    message.blocks = [
      { type: 'header', text: { type: 'plain_text', text: data.title || 'Summary Report' } },
      { type: 'section', text: { type: 'mrkdwn', text: data.content || JSON.stringify(data, null, 2).substring(0, 500) } },
    ];
  } else {
    message.blocks = [{ type: 'section', text: { type: 'mrkdwn', text: input || 'Hello from Gemini Skills!' } }];
  }
  return message;
}

runSkill('slack-communicator-pro', () => {
  const webhook = checkWebhook();
  const message = formatMessage(argv.action, argv.input, argv.channel);
  const result = {
    action: argv.action, channel: argv.channel, mode: argv['dry-run'] ? 'dry-run' : 'live',
    webhookStatus: webhook.configured ? 'configured' : 'not_configured',
    message,
    recommendations: !webhook.configured ? ['Create Slack webhook config at knowledge/personal/slack-webhook.json'] : [],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
