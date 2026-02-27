const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';

export interface WebhookStatus {
  configured: boolean;
  url?: string;
}

export function checkSlackWebhook(): WebhookStatus {
  const paths = ['knowledge/personal/slack-webhook.json', '.slack/webhook.json'];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(safeReadFile(p, 'utf8'));
        return { configured: true, url: data.url };
      } catch {}
    }
  }
  return { configured: false };
}

export function formatSlackMessage(
  action: string,
  input: string | undefined,
  channel: string
): any {
  const message: any = { channel, blocks: [] };
  if (action === 'alert') {
    message.blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'ALERT' } },
      { type: 'section', text: { type: 'mrkdwn', text: input || 'Alert!' } },
    ];
  } else {
    message.blocks = [{ type: 'section', text: { type: 'mrkdwn', text: input || 'Hello!' } }];
  }
  return message;
}
