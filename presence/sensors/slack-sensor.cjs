#!/usr/bin/env node
/**
 * Slack Sensory Organ (Sensor)
 * Listens for app mentions and direct messages via Socket Mode.
 * Injects stimuli into the Presence Layer bridge.
 */

const { App } = require('@slack/bolt');
const fs = require('fs');
const path = require('path');
const { logger, safeReadFile, safeWriteFile, pathResolver } = require('../../scripts/system-prelude.cjs');

const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/slack-credentials.json');
const STIMULI_PATH = pathResolver.rootResolve('presence/bridge/stimuli.jsonl');

async function startSensor() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    logger.error(`Slack credentials not found at ${CREDENTIALS_PATH}. Please create the Slack App and save tokens.`);
    process.exit(1);
  }

  const creds = JSON.parse(safeReadFile(CREDENTIALS_PATH, { encoding: 'utf8' }));
  
  if (!creds.app_token || !creds.bot_token) {
    logger.error('Missing app_token or bot_token in slack-credentials.json');
    process.exit(1);
  }

  const app = new App({
    token: creds.bot_token,
    appToken: creds.app_token,
    socketMode: true,
    logLevel: 'info'
  });

  // Helper to inject stimuli
  const injectStimulus = async (event, type) => {
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

    logger.info(`📡 [Slack Sensor] Detected ${type} from ${event.user}: ${event.text.substring(0, 50)}...`);
    
    // Append to stimuli.jsonl
    fs.appendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
  };

  // 1. Listen for App Mentions
  app.event('app_mention', async ({ event, say }) => {
    await injectStimulus(event, 'mention');
  });

  // 2. Listen for Direct Messages
  app.message(async ({ event, say }) => {
    if (event.channel_type === 'im' || event.channel.startsWith('D')) {
      await injectStimulus(event, 'dm');
    }
  });

  // 3. Listen for Interactivity (Buttons)
  app.action(/.*_action/, async ({ action, ack, body, say }) => {
    await ack();
    const stimulus = {
      timestamp: new Date().toISOString(),
      source_channel: 'slack',
      delivery_mode: 'REALTIME',
      type: 'action',
      payload: `USER_ACTION: ${action.action_id} (value: ${action.value})`,
      status: 'PENDING',
      metadata: {
        channel_id: body.channel.id,
        user_id: body.user.id,
        action_id: action.action_id,
        trigger_id: body.trigger_id
      }
    };
    logger.info(`🔘 [Slack Sensor] Detected action ${action.action_id} from ${body.user.name}`);
    fs.appendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
  });

  try {
    await app.start();
    logger.success('⚡️ Slack Sensory Organ is active and listening (Socket Mode).');
  } catch (err) {
    logger.error(`Failed to start Slack Sensor: ${err.message}`);
  }
}

startSensor();
