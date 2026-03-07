/**
 * Nexus Daemon v5.1 (Agnostic Dispatcher Edition)
 * Central nerve system that coordinates stimuli ingestion and terminal session routing.
 * Uses Registry-driven dispatching to remain channel-agnostic.
 */

import { logger, terminalBridge, safeReadFile, safeWriteFile, pathResolver } from '../../libs/core/index.js';
import { safeExec } from '../../libs/core/secure-io.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT_DIR = process.cwd();
const STIMULI_PATH = path.join(ROOT_DIR, 'presence/bridge/runtime/stimuli.jsonl');
const REGISTRY_PATH = pathResolver.resolve('presence/bridge/channel-registry.json');
const RUNTIME_BASE = path.join(ROOT_DIR, 'active/shared/runtime/terminal');

const CHECK_INTERVAL_MS = Number(process.env.NEXUS_INTERVAL) || 3000;
const MAX_BATCH_SIZE = Number(process.env.NEXUS_BATCH_SIZE) || 5;

interface GUSPStimulus {
  id: string;
  ts: string;
  ttl: number;
  origin: { channel: string; source_id: string; context?: string; metadata?: any };
  signal: { intent: string; priority: number; payload: string };
  control: { 
    status: 'pending' | 'injected' | 'processed' | 'expired' | 'failed';
    feedback: 'auto' | 'silent' | 'manual';
    evidence: Array<{ step: string; ts: string; agent: string }>;
  };
}

interface Channel {
  id: string;
  connector_skill?: string;
  execution_strategy?: string;
  service_id?: string;
  execution_mode?: 'API' | 'CLI' | 'SDK';
}

async function loadChannelRegistry(): Promise<Channel[]> {
  try {
    const content = safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }) as string;
    return JSON.parse(content).channels;
  } catch (err) {
    logger.error(`[Nexus] Registry load error: ${err}`);
    return [];
  }
}

async function updateStimulusStatus(id: string, status: GUSPStimulus['control']['status'], step?: string) {
  try {
    const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
    const lines = content.trim().split('\n').map(line => {
      if (!line) return '';
      const s = JSON.parse(line) as GUSPStimulus;
      if (s.id === id) {
        s.control.status = status;
        if (step) s.control.evidence.push({ step, ts: new Date().toISOString(), agent: 'nexus-daemon' });
      }
      return JSON.stringify(s);
    }).filter(l => l !== '');
    safeWriteFile(STIMULI_PATH, lines.join('\n') + '\n');
    return true;
  } catch (err: any) {
    logger.error(`[Nexus] Status update failed for ${id}: ${err.message}`);
    return false;
  }
}

/**
 * Agnostic Dispatcher: Sends feedback back using the channel's designated skill.
 */
async function dispatchFeedback(stimulus: GUSPStimulus, text: string, channels: Channel[]) {
  const channelCfg = channels.find(c => c.id === stimulus.origin.channel);
  
  if (channelCfg?.connector_skill) {
    logger.info(`📤 [Nexus] Dispatching feedback for ${stimulus.id} via ${channelCfg.connector_skill}`);
    
    let payload: any;
    
    if (channelCfg.connector_skill === 'service-actuator') {
      // New Unified Service Payload
      payload = {
        service_id: channelCfg.service_id || stimulus.origin.channel,
        mode: channelCfg.execution_mode || 'API',
        action: 'chat.postMessage', // Default for messaging channels
        params: {
          channel: stimulus.origin.context?.split(':')[0],
          thread_ts: stimulus.origin.context?.split(':')[1],
          text: text
        },
        auth: 'secret-guard'
      };
    } else {
      // Legacy Skill Payload
      payload = {
        action: 'message',
        input: text,
        metadata: stimulus.origin.metadata,
        stimulus_id: stimulus.id
      };
    }

    const tempPath = pathResolver.resolve(`active/shared/logs/dispatch_${stimulus.id}_${Date.now()}.json`);
    safeWriteFile(tempPath, JSON.stringify(payload, null, 2));

    try {
      await safeExec('node', ['dist/scripts/cli.js', 'run', channelCfg.connector_skill, '--input', tempPath]);
      logger.success(`✅ [Nexus] Dispatch successful via ${channelCfg.connector_skill}`);
    } catch (err: any) {
      logger.error(`❌ [Nexus] Dispatch failed: ${err.message}`);
    }
  } else {
    logger.info(`📝 [Nexus] Internal feedback for ${stimulus.id} (No connector): ${text.substring(0, 100)}...`);
  }
}

/**
 * Watches terminal output and triggers dispatch.
 */
async function handleFeedback(stimulus: GUSPStimulus, sessionId: string, channels: Channel[]) {
  if (stimulus.control.feedback === 'silent') return;

  const latestResponsePath = path.join(RUNTIME_BASE, sessionId, 'out', 'latest_response.json');
  const startTime = Date.now();
  const timeoutMs = 180000;
  const initialMtime = fs.existsSync(latestResponsePath) ? fs.statSync(latestResponsePath).mtimeMs : 0;

  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(latestResponsePath)) {
      const currentMtime = fs.statSync(latestResponsePath).mtimeMs;
      if (currentMtime > initialMtime) {
        try {
          const response = JSON.parse(fs.readFileSync(latestResponsePath, 'utf8'));
          const text = response.data?.message || JSON.stringify(response.data || {}, null, 2);

          await dispatchFeedback(stimulus, text, channels);
          await updateStimulusStatus(stimulus.id, 'processed', 'feedback_dispatched');
          return;
        } catch (err: any) {
          logger.error(`❌ [Feedback] Error: ${err.message}`);
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  logger.warn(`⚠️ [Feedback] Timeout for ${stimulus.id}`);
  await updateStimulusStatus(stimulus.id, 'failed', 'feedback_timeout');
}

async function nexusLoop() {
  logger.info('🛡️ Nexus Daemon (v5.1) active. Agnostic Dispatching established.');

  while (true) {
    if (fs.existsSync(STIMULI_PATH)) {
      try {
        const channels = await loadChannelRegistry();
        const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
        const allStimuli = content.trim().split('\n')
          .filter(l => l.length > 0)
          .map(line => JSON.parse(line) as GUSPStimulus);

        const pending = allStimuli.filter(s => s.control.status === 'pending');
        const batch = pending.slice(0, MAX_BATCH_SIZE);

        for (const stimulus of batch) {
          // 1. Policy/Strategy Check
          if (stimulus.origin.channel === 'system') {
            await updateStimulusStatus(stimulus.id, 'processed', 'ignored_by_policy');
            continue;
          }

          // 2. TTL Check
          const age = (Date.now() - new Date(stimulus.ts).getTime()) / 1000;
          if (stimulus.ttl > 0 && age > stimulus.ttl) {
            await updateStimulusStatus(stimulus.id, 'expired', 'ttl_expiration');
            continue;
          }

          // 3. Routing
          const session = terminalBridge.findIdleSession();
          if (session) {
            // OSASCRIPT Safety Check
            if (session.type === 'iTerm2' && process.env.OSASCRIPT_ENABLED === 'false') {
              logger.warn(`🚫 Skipping iTerm2 injection for ${stimulus.id} (OSASCRIPT_ENABLED=false)`);
              continue; 
            }

            logger.info(`🚀 [Nexus] Injecting ${stimulus.id} (${stimulus.origin.channel}) -> ${session.type} (${session.sessionId})`);
            
            const success = await terminalBridge.injectAndExecute(session.winId, session.sessionId, stimulus.signal.payload, session.type);
            if (success) {
              await updateStimulusStatus(stimulus.id, 'injected', 'injection_success');
              handleFeedback(stimulus, session.sessionId, channels).catch(e => logger.error(`Dispatch Error: ${e.message}`));
            } else {
              await updateStimulusStatus(stimulus.id, 'failed', 'injection_failed');
            }
          } else {
            break;
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
