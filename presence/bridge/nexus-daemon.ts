/**
 * Nexus Daemon v3.0 (GUSP v1.0 Edition)
 * Central nerve system that coordinates stimuli ingestion, terminal injection, 
 * and feedback mirroring using the Unified Sensory Protocol.
 */

import { logger, safeReadFile, safeWriteFile, pathResolver, terminalBridge } from '@agent/core';
import { WebClient } from '@slack/web-api';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/connections/slack/slack-credentials.json');
const LAST_RESPONSE_PATH = pathResolver.resolve('presence/bridge/runtime/last_response.json');
const CHECK_INTERVAL_MS = 3000;

interface GUSPStimulus {
  id: string;
  ts: string;
  ttl: number;
  origin: {
    channel: string;
    source_id?: string;
    context?: string;
  };
  signal: {
    intent: string;
    priority: number;
    payload: string;
  };
  control: {
    status: 'pending' | 'injected' | 'processed' | 'expired' | 'failed';
    feedback: 'auto' | 'silent' | 'manual';
    evidence: Array<{ step: string; ts: string; agent: string }>;
  };
}

let slackClient: WebClient | null = null;

function getSlackClient() {
  if (slackClient) return slackClient;
  if (fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      if (creds.bot_token) {
        slackClient = new WebClient(creds.bot_token);
        return slackClient;
      }
    } catch (e) {}
  }
  return null;
}

async function updateStimulusStatus(id: string, status: GUSPStimulus['control']['status'], step?: string) {
  try {
    const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
    const lines = content.trim().split('\n').map(line => {
      if (!line) return '';
      const s = JSON.parse(line) as GUSPStimulus;
      if (s.id === id) {
        s.control.status = status;
        if (step) {
          s.control.evidence.push({ step, ts: new Date().toISOString(), agent: 'nexus-daemon' });
        }
      }
      return JSON.stringify(s);
    }).filter(l => l !== '');
    safeWriteFile(STIMULI_PATH, lines.join('\n') + '\n');
    return true;
  } catch (err: any) {
    logger.error(`[Nexus] Update failed for ${id}: ${err.message}`);
    return false;
  }
}

async function handleFeedback(stimulus: GUSPStimulus) {
  if (stimulus.control.feedback === 'silent') return;

  logger.info(`⏳ [Feedback] Watching response for stimulus ${stimulus.id}...`);
  
  const startTime = Date.now();
  const timeoutMs = 120000; // 2 minutes
  const initialMtime = fs.existsSync(LAST_RESPONSE_PATH) ? fs.statSync(LAST_RESPONSE_PATH).mtimeMs : 0;

  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(LAST_RESPONSE_PATH)) {
      const currentMtime = fs.statSync(LAST_RESPONSE_PATH).mtimeMs;
      if (currentMtime > initialMtime) {
        try {
          const response = JSON.parse(fs.readFileSync(LAST_RESPONSE_PATH, 'utf8'));
          let text = '';
          if (response.status === 'success') {
            text = typeof response.data === 'string' ? response.data : (response.data.message || JSON.stringify(response.data, null, 2));
          } else {
            text = `Error: ${response.error?.message}`;
          }

          if (stimulus.origin.channel === 'slack' && stimulus.origin.context) {
            const client = getSlackClient();
            if (client) {
              const [channelId, threadTs] = stimulus.origin.context.split(':');
              await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: `🤖 *Gemini 応答 (${stimulus.id}):*\n\n${text.substring(0, 3000)}`
              });
              logger.success(`📬 [Feedback] Mirrored to Slack for ${stimulus.id}`);
              await updateStimulusStatus(stimulus.id, 'processed', 'feedback_mirrored');
              return;
            }
          }
        } catch (err: any) {
          logger.error(`❌ [Feedback] Processing error: ${err.message}`);
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  logger.warn(`⚠️ [Feedback] Timeout for ${stimulus.id}`);
  await updateStimulusStatus(stimulus.id, 'failed', 'feedback_timeout');
}

async function nexusLoop() {
  logger.info('🛡️ Nexus Daemon (v3.0) active. GUSP v1.0 Link established.');

  while (true) {
    if (fs.existsSync(STIMULI_PATH)) {
      try {
        const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
        const allStimuli = content.trim().split('\n')
          .filter(l => l.length > 0)
          .map(line => JSON.parse(line) as GUSPStimulus);

        const pending = allStimuli.filter(s => s.control.status === 'pending');

        for (const stimulus of pending) {
          // 1. TTL Check
          const age = (Date.now() - new Date(stimulus.ts).getTime()) / 1000;
          if (stimulus.ttl > 0 && age > stimulus.ttl) {
            logger.warn(`🚫 Stimulus ${stimulus.id} expired (Age: ${Math.round(age)}s)`);
            await updateStimulusStatus(stimulus.id, 'expired', 'ttl_expiration');
            continue;
          }

          // 2. Find Terminal Hub
          const session = terminalBridge.findIdleSession();
          if (session) {
            logger.info(`🚀 Injecting GUSP ${stimulus.id} -> ${session.type}`);
            
            const success = await terminalBridge.injectAndExecute(session.winId, session.sessionId, stimulus.signal.payload, session.type);
            if (success) {
              await updateStimulusStatus(stimulus.id, 'injected', 'injection_success');
              handleFeedback(stimulus).catch(e => logger.error(`Feedback Loop Error: ${e.message}`));
            } else {
              await updateStimulusStatus(stimulus.id, 'failed', 'injection_failed');
            }
          }
        }
      } catch (err: any) {
        logger.error(`[Nexus] Loop Error: ${err.message}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

nexusLoop().catch(err => {
  logger.error(`Nexus Daemon crashed: ${err.message}`);
  process.exit(1);
});
