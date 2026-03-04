/**
 * Nexus Daemon v2.3 (File-Based Feedback Edition)
 * Background stimuli watcher that triggers physical terminal intervention 
 * and mirrors the response back to the source channel via persistent files.
 */

import { logger, safeReadFile, safeWriteFile, pathResolver, terminalBridge } from '@agent/core';
import { WebClient } from '@slack/web-api';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/stimuli.jsonl');
const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/connections/slack/slack-credentials.json');
const LAST_RESPONSE_PATH = pathResolver.resolve('active/shared/last_response.json');
const CHECK_INTERVAL_MS = 5000;

interface Stimulus {
  timestamp: string;
  source_channel: string;
  payload: string;
  status: 'PENDING' | 'INJECTED' | 'PROCESSED';
  metadata: {
    channel_id?: string;
    thread_ts?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

let slackClient: WebClient | null = null;

function getSlackClient() {
  if (slackClient) return slackClient;
  if (fs.existsSync(CREDENTIALS_PATH)) {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    if (creds.bot_token) {
      slackClient = new WebClient(creds.bot_token);
      return slackClient;
    }
  }
  return null;
}

async function markAsInjected(timestamp: string): Promise<boolean> {
  try {
    const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
    const lines = content.trim().split('\n').map(line => {
      if (!line) return '';
      const s = JSON.parse(line) as Stimulus;
      if (s.timestamp === timestamp) {
        s.status = 'INJECTED';
        s.injected_at = new Date().toISOString();
      }
      return JSON.stringify(s);
    }).filter(l => l !== '');
    safeWriteFile(STIMULI_PATH, lines.join('\n') + '\n');
    return true;
  } catch (err: any) {
    logger.error(`Failed to mark as injected: ${err.message}`);
    return false;
  }
}

async function waitForFileResponseAndReply(stimulus: Stimulus) {
  logger.info(`⏳ [Feedback] Watching for file-based response for ${stimulus.source_channel}...`);
  
  // Watch for changes in last_response.json
  const startTime = Date.now();
  const timeoutMs = 60000; // Wait up to 1 minute for AI to finish
  const initialMtime = fs.existsSync(LAST_RESPONSE_PATH) ? fs.statSync(LAST_RESPONSE_PATH).mtimeMs : 0;

  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(LAST_RESPONSE_PATH)) {
      const currentMtime = fs.statSync(LAST_RESPONSE_PATH).mtimeMs;
      if (currentMtime > initialMtime) {
        // New response detected!
        try {
          const response = JSON.parse(fs.readFileSync(LAST_RESPONSE_PATH, 'utf8'));
          let text = '';
          if (response.status === 'success') {
            text = typeof response.data === 'string' ? response.data : (response.data.message || JSON.stringify(response.data, null, 2));
          } else {
            text = `Error: ${response.error?.message}`;
          }

          if (stimulus.source_channel === 'slack' && stimulus.metadata.channel_id) {
            const client = getSlackClient();
            if (client) {
              const ts = stimulus.metadata.thread_ts || stimulus.metadata.event_ts;
              await client.chat.postMessage({
                channel: stimulus.metadata.channel_id,
                thread_ts: ts,
                text: `🤖 *Gemini 応答:*\n\n${text.substring(0, 3000)}`
              });
              logger.success(`📬 [Feedback] Response mirrored via file to Slack.`);
              return;
            }
          }
        } catch (err: any) {
          logger.error(`❌ [Feedback] Error processing response file: ${err.message}`);
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  logger.warn(`⚠️ [Feedback] Timeout waiting for AI response file.`);
}

async function nexusLoop() {
  logger.info('🛡️ Nexus Daemon (v2.3) active. File-based feedback loop enabled.');

  while (true) {
    if (fs.existsSync(STIMULI_PATH)) {
      try {
        const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
        const pending = content.trim().split('\n')
          .filter(l => l.length > 0)
          .map(line => JSON.parse(line) as Stimulus)
          .filter(s => s.status === 'PENDING');

        if (pending.length > 0) {
          const stimulus = pending[0];
          logger.info(`📡 Stimulus detected: [${stimulus.source_channel}] ${stimulus.payload.substring(0, 30)}...`);

          const session = terminalBridge.findIdleSession();
          if (session) {
            logger.info(`🚀 Terminal (${session.type}) is IDLE. Injecting...`);
            
            const cleanPayload = stimulus.payload.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
            const cmd = `\n[SENSORY_INPUT_BEGIN]\nSource: ${stimulus.source_channel}\nPayload: <<<\n${cleanPayload}\n>>>\n[SENSORY_INPUT_END]\n`;
            
            const success = terminalBridge.injectAndExecute(session.winId, session.sessionId, cmd, session.type);
            if (success) {
              await markAsInjected(stimulus.timestamp);
              logger.success(`✅ Injected. Watching for result file.`);
              
              // Start background watcher for the response file
              waitForFileResponseAndReply(stimulus).catch(e => logger.error(`Feedback Error: ${e.message}`));
            }
          }
        }
      } catch (err: any) {
        logger.error(`Loop Error: ${err.message}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

nexusLoop().catch(err => {
  logger.error(`Nexus Daemon crashed: ${err.message}`);
  process.exit(1);
});
