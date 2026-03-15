import { App, LogLevel } from '@slack/bolt';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'node:path';
import { logger, secretGuard, safeAppendFileSync } from '@agent/core';

/**
 * Slack Sensory Satellite (Socket Mode) v1.0
 * Ingests Slack messages as GUSP v2.0 Stimuli.
 */

const STIMULI_PATH = path.join(process.cwd(), 'presence/bridge/runtime/stimuli.jsonl');

async function start() {
  const appToken = secretGuard.getSecret('SLACK_APP_TOKEN');
  const botToken = secretGuard.getSecret('SLACK_BOT_TOKEN');

  if (!appToken || !botToken) {
    logger.error('❌ Missing SLACK_APP_TOKEN or SLACK_BOT_TOKEN in SecretGuard.');
    process.exit(1);
  }

  const app = new App({
    token: botToken,
    appToken: appToken,
    socketMode: true,
    logLevel: LogLevel.INFO
  });

  // 1. Listen for messages
  app.message(async ({ message }) => {
    // Only process text messages (ignore edits, deletes, etc. for now)
    if (!('text' in message) || !message.text) return;
    if (message.subtype) return; // Ignore bot messages or other subtypes

    const stimulusId = uuidv4();
    const ts = new Date().toISOString();
    const threadTs = 'thread_ts' in message && typeof message.thread_ts === 'string' ? message.thread_ts : message.ts;
    const team = 'team' in message && typeof message.team === 'string' ? message.team : undefined;
    const channelType = 'channel_type' in message && typeof message.channel_type === 'string' ? message.channel_type : undefined;

    // 2. Convert to GUSP v2.0
    const stimulus = {
      id: stimulusId,
      ts: ts,
      ttl: 3600,
      origin: {
        channel: 'slack',
        source_id: message.user,
        context: `${message.channel}:${threadTs}`,
        metadata: {
          team,
          channel_type: channelType
        }
      },
      signal: {
        type: 'CHAT',
        priority: 5,
        payload: message.text
      },
      policy: {
        flow: 'LOOPBACK',
        feedback: 'auto',
        retention: 'ephemeral'
      },
      control: {
        status: 'pending',
        evidence: []
      }
    };

    // 3. Physical Ingestion (Evidence-as-State)
    try {
      logger.info(`📥 [SlackBridge] Ingesting stimulus ${stimulusId} from ${message.user}`);
      safeAppendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n', 'utf8');
    } catch (err: any) {
      logger.error(`❌ [SlackBridge] Ingestion failed: ${err.message}`);
    }
  });

  // 2. Start the app
  await app.start();
  logger.info('🛡️ Slack Sensory Satellite is online (Socket Mode). Listening for stimuli...');
}

start().catch(err => {
  logger.error(`SlackBridge crashed: ${err.message}`);
  process.exit(1);
});
