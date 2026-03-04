/**
 * Slack Sensory Organ (Sensor) v2.0 (Type-Safe TS Edition)
 * Listens for app mentions and direct messages via Socket Mode.
 */

import { App } from '@slack/bolt';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, safeReadFile, pathResolver } from '@agent/core';

const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/connections/slack/slack-credentials.json');
const STIMULI_PATH = pathResolver.rootResolve('presence/bridge/stimuli.jsonl');

interface SlackCredentials {
  bot_token: string;
  app_token: string;
}

async function startSensor() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    logger.error(`Slack credentials not found at ${CREDENTIALS_PATH}`);
    process.exit(1);
  }

  const creds = JSON.parse(safeReadFile(CREDENTIALS_PATH, { encoding: 'utf8' }) as string) as SlackCredentials;
  
  if (!creds.app_token || !creds.bot_token) {
    logger.error('Missing app_token or bot_token in slack-credentials.json');
    process.exit(1);
  }

  const app = new App({
    token: creds.bot_token,
    appToken: creds.app_token,
    socketMode: true,
    logLevel: 'debug' as any
  });

  const injectStimulus = async (event: any, type: string) => {
    const stimulus = {
      timestamp: new Date().toISOString(),
      source_channel: 'slack',
      delivery_mode: 'BATCH',
      type: type,
      payload: event.text,
      status: 'PENDING',
      metadata: {
        channel_id: event.channel,
        user_id: event.user,
        thread_ts: event.thread_ts || event.ts,
        event_ts: event.ts
      }
    };

    logger.info(`📡 [Slack Sensor] Detected ${type} from ${event.user}: ${event.text?.substring(0, 50)}...`);
    fs.appendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + "\n");
    try { await app.client.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts || event.ts, text: "👀 指示を受信しました。ターミナルで処理を開始します..." }); } catch (e: any) { logger.error(`ACK failed: ${e.message}`); }
  };

  app.event('app_mention', async ({ event }) => {
    await injectStimulus(event, 'mention');
  });

  app.message(async ({ event }) => {
    // Check if it's a DM (direct message)
    const e = event as any;
    if (e.channel_type === 'im' || e.channel?.startsWith('D')) {
      await injectStimulus(e, 'dm');
    }
  });

  try {
    await app.start();
    logger.success('⚡️ Slack Sensory Organ (TS) is active and listening.');
  } catch (err: any) {
    logger.error(`Failed to start Slack Sensor: ${err.message}`);
  }
}

startSensor();
