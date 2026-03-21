/**
 * Nexus Daemon v6.1 [STANDARDIZED]
 * Central nerve system that coordinates stimuli ingestion and terminal session routing.
 * Standardized with Secure-IO and Physical Evidence-as-State.
 */

import {
  logger, 
  terminalBridge, 
  safeReadFile, 
  safeWriteFile, 
  pathResolver,
  secretGuard,
  safeMkdir,
  safeExistsSync,
  safeUnlinkSync,
  safeReaddir,
  sensoryMemory,
  capabilityEntry,
  safeExec,
} from '@agent/core';
import { reflexEngine } from '@agent/shared-nerve';
import { handleAction as dispatchService } from '@actuator/service';
import * as path from 'node:path';

const ROOT_DIR = pathResolver.rootDir();
const STIMULI_PATH = path.join(ROOT_DIR, 'presence/bridge/runtime/stimuli.jsonl');
const REGISTRY_PATH = pathResolver.resolve('presence/bridge/channel-registry.json');
const RUNTIME_BASE = path.join(ROOT_DIR, 'active/shared/runtime/terminal');
const NEXUS_MISSION_ID = 'MSN-SYSTEM-NEXUS-DISPATCH';

/**
 * Ensures the system mission exists physically for TIBA compliance.
 */
function ensureSystemMission() {
  const missionDir = path.join(ROOT_DIR, 'active/missions', NEXUS_MISSION_ID);
  const statePath = path.join(missionDir, 'mission-state.json');
  
  if (!safeExistsSync(missionDir)) {
    safeMkdir(missionDir, { recursive: true });
  }
  
  const state = {
    mission_id: NEXUS_MISSION_ID,
    status: 'Active',
    started_at: new Date().toISOString(),
    role: 'System Dispatcher'
  };
  
  safeWriteFile(statePath, JSON.stringify(state, null, 2));
  logger.info(`🛡️ [Nexus] System Mission physical state established.`);
}

const CHECK_INTERVAL_MS = Number(process.env.NEXUS_INTERVAL) || 3000;

interface GUSPStimulus {
  id: string;
  ts: string;
  ttl: number;
  origin: { channel: string; source_id: string; context?: string; metadata?: any };
  signal: { type: string; priority: number; payload: string };
  policy: { flow: string; feedback: string; retention: string };
  control: { 
    status: 'pending' | 'injected' | 'processed' | 'expired' | 'failed';
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

async function dispatchFeedback(stimulus: GUSPStimulus, text: string, channels: Channel[]) {
  const channelCfg = channels.find(c => c.id === stimulus.origin.channel);
  
  if (channelCfg?.connector_skill) {
    logger.info(`📤 [Nexus] Dispatching feedback for ${stimulus.id} via ${channelCfg.connector_skill}`);
    
    const cleanText = text.replace(/^\/(gemini|claude|codex|shell)\s+/i, '').trim();
    const contextParts = stimulus.origin.context?.split(':') || [];
    const targetChannel = contextParts[0] || 'C0AJ7EHH8BB'; 
    const threadTs = contextParts[1];

    const payload = {
      service_id: channelCfg.service_id || stimulus.origin.channel,
      mode: channelCfg.execution_mode || 'API',
      action: 'chat.postMessage', 
      params: {
        channel: targetChannel,
        thread_ts: threadTs,
        text: cleanText
      },
      auth: 'secret-guard'
    };

    const tempPath = pathResolver.resolve(`active/shared/logs/dispatch_${stimulus.id}_${Date.now()}.json`);
    safeWriteFile(tempPath, JSON.stringify(payload, null, 2));

    try {
      const serviceId = channelCfg.service_id || stimulus.origin.channel || 'slack';
      secretGuard.grantAccess(NEXUS_MISSION_ID, serviceId, 5);

      const actuatorPath = capabilityEntry(channelCfg.connector_skill);
      logger.info(`🚀 [Nexus] Dispatching via node ${actuatorPath}...`);
      
      const rawOutput = await safeExec('node', [actuatorPath, '--input', tempPath], {
        env: { ...process.env, MISSION_ID: NEXUS_MISSION_ID }
      });
      
      const jsonStart = rawOutput.indexOf('{');
      if (jsonStart === -1) {
        logger.error(`❌ [Nexus] Dispatch Error: No JSON found in output.`);
        logger.error(`Raw Output: "${rawOutput}"`);
        throw new Error(`Invalid output format.`);
      }
      const output = rawOutput.substring(jsonStart);

      logger.info(`📡 [Nexus] Actuator Response received (${output.length} bytes)`);
      const result = JSON.parse(output);
      if (result.ok === false) {
        logger.error(`❌ [Nexus] Slack API Error: ${result.error}`);
      } else {
        logger.success(`✅ [Nexus] Dispatch successful!`);
      }
    } catch (err: any) {
      logger.error(`❌ [Nexus] Dispatch failed: ${err.message}`);
    }
  } else {
    logger.info(`📝 [Nexus] Internal feedback for ${stimulus.id} (No connector): ${text.substring(0, 100)}...`);
  }
}

function extractBrainProfile(payload: string): { profile: string, cleanPayload: string } {
  const match = payload.match(/^\/([a-z0-9_-]+)\s+(.*)/is);
  if (match) {
    const profile = match[1].toLowerCase();
    const cleanPayload = match[2];
    
    try {
      const registryPath = pathResolver.resolve('knowledge/orchestration/brain-profiles.json');
      if (safeExistsSync(registryPath)) {
        const registry = JSON.parse(safeReadFile(registryPath, { encoding: 'utf8' }) as string);
        if (registry.profiles[profile]) {
          return { profile, cleanPayload };
        }
      }
    } catch (_) {}
  }
  
  return { profile: 'default', cleanPayload: payload };
}

async function scanAndDispatch(channels: Channel[]) {
  if (!safeExistsSync(STIMULI_PATH)) return;

  const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
  const allStimuli = content.trim().split('\n')
    .filter(l => l.length > 0)
    .map(line => JSON.parse(line) as GUSPStimulus);

  const injected = allStimuli.filter(s => s.control.status === 'injected');

  for (const stimulus of injected) {
    if (stimulus.policy.feedback === 'silent') {
      await updateStimulusStatus(stimulus.id, 'processed', 'ignored_by_silent_policy');
      continue;
    }

    const sessions = safeExistsSync(RUNTIME_BASE) ? safeReaddir(RUNTIME_BASE) : [];
    for (const sid of sessions) {
      const outDir = path.join(RUNTIME_BASE, sid, 'out');
      const metaPath = path.join(outDir, 'latest_metadata.json');
      const responsePath = path.join(outDir, 'latest_response.json');

      if (safeExistsSync(metaPath) && safeExistsSync(responsePath)) {
        try {
          const meta = JSON.parse(safeReadFile(metaPath, { encoding: 'utf8' }) as string);
          if (meta.stimulus_id === stimulus.id) {
            const response = JSON.parse(safeReadFile(responsePath, { encoding: 'utf8' }) as string);
            const text = response.data?.message || JSON.stringify(response.data || {}, null, 2);

            logger.info(`🎯 [Nexus] Match found! Stimulus ${stimulus.id} -> Session ${sid}`);
            await dispatchFeedback(stimulus, text, channels);
            await updateStimulusStatus(stimulus.id, 'processed', 'feedback_dispatched');
            
            safeUnlinkSync(metaPath);
            break;
          }
        } catch (err: any) {
          logger.error(`[Nexus] Metadata check error in session ${sid}: ${err.message}`);
        }
      }
    }
  }
}

async function nexusLoop() {
  logger.info('🛡️ Nexus Daemon (v6.1) standardized. Stateless Evidence-as-State established.');

  ensureSystemMission();

  // Initialize Reflex Engine with a generic dispatcher
  reflexEngine.setDispatcher(async (actuator, action, params) => {
    logger.info(`⚡ [Nexus:Reflex] Executing autonomic reaction: ${actuator}.${action}`);
    if (actuator === 'service-actuator') {
      await dispatchService({
        service_id: params.service_id || 'slack',
        mode: 'API',
        action: action,
        params: params,
        auth: 'secret-guard'
      });
    }
  });

  while (true) {
    try {
      const channels = await loadChannelRegistry();
      
      if (safeExistsSync(STIMULI_PATH)) {
        const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
        const allStimuli = content.trim().split('\n')
          .filter(l => l.length > 0)
          .map(line => JSON.parse(line) as GUSPStimulus);

        const pending = allStimuli.filter(s => s.control.status === 'pending');

        for (const stimulus of pending) {
          // 1. Add to Sensory Memory for context
          sensoryMemory.remember(stimulus as any);

          // 2. Evaluate autonomic reflexes
          await reflexEngine.evaluate(stimulus as any);

          const age = (Date.now() - new Date(stimulus.ts).getTime()) / 1000;
          if (stimulus.ttl > 0 && age > stimulus.ttl) {
            await updateStimulusStatus(stimulus.id, 'expired', 'ttl_expiration');
            continue;
          }

          const sessionPrefix = 's-';
          const sessionSuffix = stimulus.origin.source_id.substring(stimulus.origin.source_id.length - 8).toLowerCase();
          const targetSessionId = `${sessionPrefix}${sessionSuffix}`;

          logger.info(`🚀 [Nexus] Routing ${stimulus.id} to session ${targetSessionId} (Affinity: ${stimulus.origin.source_id})`);
          
          const { profile, cleanPayload } = extractBrainProfile(stimulus.signal.payload);
          
          const sessionInDir = path.join(RUNTIME_BASE, targetSessionId, 'in');
          if (!safeExistsSync(sessionInDir)) safeMkdir(sessionInDir, { recursive: true });

          const metaInPath = path.join(sessionInDir, 'metadata.json');
          safeWriteFile(metaInPath, JSON.stringify({
            stimulus_id: stimulus.id,
            origin: stimulus.origin,
            policy: stimulus.policy,
            brain_profile: profile
          }, null, 2));

          const success = await terminalBridge.injectAndExecute(null as any, targetSessionId, cleanPayload, 'ReflexTerminal');
          if (success) {
            await updateStimulusStatus(stimulus.id, 'injected', 'injection_success');
          } else {
            await updateStimulusStatus(stimulus.id, 'failed', 'injection_failed');
          }
        }
      }

      await scanAndDispatch(channels);

    } catch (err: any) {
      logger.error(`[Nexus] Loop Error: ${err.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

nexusLoop().catch(err => {
  logger.error(`Nexus Daemon crashed: ${err.message}`);
  process.exit(1);
});
