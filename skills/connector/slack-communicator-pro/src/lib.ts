import { WebClient } from '@slack/web-api';
const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';

export interface SlackCredentials {
  bot_token?: string;
  app_token?: string;
  webhook_url?: string;
}

export function loadSlackCredentials(): SlackCredentials {
  const paths = [
    'knowledge/personal/slack-credentials.json',
    'knowledge/personal/slack-webhook.json',
    '.slack/credentials.json'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string);
        return {
          bot_token: data.bot_token || data.token,
          app_token: data.app_token,
          webhook_url: data.url || data.webhook_url
        };
      } catch {}
    }
  }
  return {};
}

export async function sendSlackMessage(
  action: string,
  input: string | undefined,
  channel: string,
  threadTs?: string
): Promise<any> {
  const creds = loadSlackCredentials();
  
  if (creds.bot_token) {
    const client = new WebClient(creds.bot_token);
    const message = formatSlackMessage(action, input, channel);
    return await client.chat.postMessage({
      ...message,
      text: input || 'Gemini System Notification',
      thread_ts: threadTs
    });
  } else if (creds.webhook_url) {
    const axios = require('axios');
    const message = formatSlackMessage(action, input, channel);
    return await axios.post(creds.webhook_url, message);
  } else {
    throw new Error('No Slack credentials or webhook configured.');
  }
}

export function formatSlackMessage(
  action: string,
  input: string | undefined,
  channel: string
): any {
  const message: any = { channel, blocks: [] };
  const text = input || (action === 'alert' ? 'Alert!' : 'Hello!');
  
  if (action === 'alert') {
    message.blocks = [
      { type: 'header', text: { type: 'plain_text', text: '🚨 GEMINI SYSTEM ALERT' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Status:* High Priority\n*Message:* ${text}` } },
    ];
  } else if (action === 'actionable') {
    message.blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: text } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve & Execute' },
            style: 'primary',
            action_id: 'approve_action',
            value: 'approved'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reject' },
            style: 'danger',
            action_id: 'reject_action',
            value: 'rejected'
          }
        ]
      }
    ];
  } else {
    message.blocks = [{ type: 'section', text: { type: 'mrkdwn', text: text } }];
  }
  return message;
}
