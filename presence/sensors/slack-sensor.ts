/**
 * Slack Sensory Organ (Sensor) v2.1 (GUSP v1.0 Edition)
 * Listens for app mentions and direct messages, producing GUSP-compliant stimuli.
 */

import { App } from '@slack/bolt';
import * as crypto from 'node:crypto';
import { logger, safeReadFile, pathResolver, safeExistsSync, safeAppendFileSync } from '@agent/core';

const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/connections/slack/slack-credentials.json');
const STIMULI_PATH = pathResolver.rootResolve('presence/bridge/runtime/stimuli.jsonl');

interface SlackCredentials {
  bot_token: string;
  app_token: string;
}

async function startSensor() {
  if (!safeExistsSync(CREDENTIALS_PATH)) {
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
    logLevel: 'info' as any
  });

  const injectStimulus = async (event: any, type: string) => {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
    const shortId = crypto.randomBytes(3).toString('hex');
    
    // GUSP v1.0 Compliant Schema
    const stimulus = {
      id: `req-${dateStr}-${shortId}`,
      ts: date.toISOString(),
      ttl: 3600,
      origin: {
        channel: 'slack',
        source_id: event.user,
        context: `${event.channel}:${event.thread_ts || event.ts}`
      },
      signal: {
        intent: 'command',
        priority: 5,
        payload: event.text
      },
      control: {
        status: 'pending',
        feedback: 'auto',
        evidence: [
          { step: 'sensor_detection', ts: date.toISOString(), agent: 'slack-sensor' }
        ]
      }
    };

    logger.info(`📡 [Slack Sensor] GUSP Stimulus produced: ${stimulus.id} (${type})`);
    
    safeAppendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + "\n");
    
    try { 
      await app.client.chat.postMessage({ 
        channel: event.channel, 
        thread_ts: event.thread_ts || event.ts, 
        text: `👀 指示を受信しました (${stimulus.id})。ターミナルで処理を開始します...` 
      }); 
    } catch (e: any) { 
      logger.error(`ACK failed: ${e.message}`); 
    }
  };

  app.event('app_mention', async ({ event }) => {
    await injectStimulus(event, 'mention');
  });

  app.message(async ({ event }) => {
    const e = event as any;
    if (e.channel_type === 'im' || e.channel?.startsWith('D')) {
      await injectStimulus(e, 'dm');
    }
  });

  try {
    await app.start();
    logger.success('⚡️ Slack Sensory Organ (GUSP v1.0) is active.');
  } catch (err: any) {
    logger.error(`Failed to start Slack Sensor: ${err.message}`);
  }
}

startSensor();
