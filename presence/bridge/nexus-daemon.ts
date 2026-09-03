/**
 * Nexus Daemon v6.1 [STANDARDIZED]
 * Central nerve system that coordinates stimuli ingestion and terminal session routing.
 * Standardized with Secure-IO and Physical Evidence-as-State.
 */

import { installProcessGuards } from '@agent/core/process-guards';
import { logger } from '@agent/core/core';
import { loadChannelRegistry, type ChannelRegistryChannel } from '@agent/core/channel-registry';
import { nowIso, parseSafeJsonInput, readJson } from '@agent/core/foundation';
import { terminalBridge } from '@agent/core/terminal-bridge';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeLstat,
  safeUnlinkSync,
  safeReaddir,
  safeExec,
} from '@agent/core/secure-io';
import { capabilityEntry, pathResolver } from '@agent/core/path-resolver';
import { secretGuard } from '@agent/core/secret-guard';
import { sensoryMemory } from '@agent/core/sensory-memory';
import { reflexEngine } from '@agent/shared-nerve';
import { handleAction as dispatchService } from '@actuator/service';
import * as path from 'node:path';
import { parseGuspStimulusLine, type GuspStimulus } from './nexus-stimulus.js';
import {
  parseNexusBrainProfileRegistry,
  parseNexusSessionMetadata,
  parseNexusSessionResponse,
} from './nexus-runtime-records.js';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('nexus-daemon');

const ROOT_DIR = pathResolver.rootDir();
const STIMULI_PATH = path.join(ROOT_DIR, 'presence/bridge/runtime/stimuli.jsonl');
const RUNTIME_BASE = path.join(ROOT_DIR, 'active/shared/runtime/terminal');
const NEXUS_MISSION_ID = 'MSN-SYSTEM-NEXUS-DISPATCH';

function readNexusJson(filePath: string): unknown {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`Nexus JSON resource must be an existing regular file: ${safePath}`);
  }
  return readJson(safePath);
}

function safeNexusPath(filePath: string, allowMissingLeaf = false): string {
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf });
}

function isExistingRegularFile(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

function isExistingDirectory(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isDirectory();
  } catch {
    return false;
  }
}

interface NexusDispatchResult {
  ok: boolean;
  error?: string;
}

function parseNexusDispatchResult(value: unknown): NexusDispatchResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ok = record.ok;
  if (ok !== undefined && typeof ok !== 'boolean') return null;
  if (record.error !== undefined && typeof record.error !== 'string') return null;
  return {
    ok: typeof ok === 'boolean' ? ok : true,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  };
}

/**
 * Ensures the system mission exists physically for TIBA compliance.
 */
function ensureSystemMission() {
  const missionDir = path.join(ROOT_DIR, 'active/missions', NEXUS_MISSION_ID);
  const safeMissionDir = safeNexusPath(missionDir, true);
  const statePath = safeNexusPath(path.join(safeMissionDir, 'mission-state.json'), true);

  if (!safeExistsSync(safeMissionDir)) {
    safeMkdir(safeMissionDir, { recursive: true });
  }

  const state = {
    mission_id: NEXUS_MISSION_ID,
    status: 'Active',
    started_at: nowIso(),
    role: 'System Dispatcher',
  };

  safeWriteFile(statePath, JSON.stringify(state, null, 2));
  logger.info(`🛡️ [Nexus] System Mission physical state established.`);
}

const CHECK_INTERVAL_MS = Number(process.env.NEXUS_INTERVAL) || 3000;

async function loadNexusChannelRegistry(): Promise<ChannelRegistryChannel[]> {
  try {
    return loadChannelRegistry().channels;
  } catch (err) {
    logger.error(`[Nexus] Registry load error: ${err}`);
    return [];
  }
}

async function updateStimulusStatus(
  id: string,
  status: GuspStimulus['control']['status'],
  step?: string
) {
  try {
    const stimuliPath = safeNexusPath(STIMULI_PATH);
    if (!isExistingRegularFile(stimuliPath)) return false;
    const content = safeReadFile(stimuliPath, { encoding: 'utf8' }) as string;
    const lines = content
      .trim()
      .split('\n')
      .map((line) => {
        if (!line) return '';
        const s = parseGuspStimulusLine(line);
        if (!s) return line;
        if (s.id === id) {
          s.control.status = status;
          if (step) s.control.evidence.push({ step, ts: nowIso(), agent: 'nexus-daemon' });
        }
        return JSON.stringify(s);
      })
      .filter((l) => l !== '');
    safeWriteFile(stimuliPath, lines.join('\n') + '\n');
    return true;
  } catch (err: any) {
    logger.error(`[Nexus] Status update failed for ${id}: ${err.message}`);
    return false;
  }
}

async function dispatchFeedback(
  stimulus: GuspStimulus,
  text: string,
  channels: ChannelRegistryChannel[]
) {
  const channelCfg = channels.find((c) => c.id === stimulus.origin.channel);

  if (channelCfg?.connector_skill) {
    logger.info(
      `📤 [Nexus] Dispatching feedback for ${stimulus.id} via ${channelCfg.connector_skill}`
    );

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
        text: cleanText,
      },
      auth: 'secret-guard',
    };

    const tempPath = pathResolver.resolve(
      `active/shared/logs/dispatch_${stimulus.id}_${Date.now()}.json`
    );
    const safeTempPath = safeNexusPath(tempPath, true);
    safeWriteFile(safeTempPath, JSON.stringify(payload, null, 2));

    try {
      const serviceId = channelCfg.service_id || stimulus.origin.channel || 'slack';
      secretGuard.grantAccess(NEXUS_MISSION_ID, serviceId, 5);

      const actuatorPath = capabilityEntry(channelCfg.connector_skill);
      logger.info(`🚀 [Nexus] Dispatching via node ${actuatorPath}...`);

      const rawOutput = await safeExec('node', [actuatorPath, '--input', safeTempPath], {
        env: { ...process.env, MISSION_ID: NEXUS_MISSION_ID },
      });

      const jsonStart = rawOutput.indexOf('{');
      if (jsonStart === -1) {
        logger.error(`❌ [Nexus] Dispatch Error: No JSON found in output.`);
        logger.error(`Raw Output: "${rawOutput}"`);
        throw new Error(`Invalid output format.`);
      }
      const output = rawOutput.substring(jsonStart);

      logger.info(`📡 [Nexus] Actuator Response received (${output.length} bytes)`);
      const result = parseNexusDispatchResult(
        parseSafeJsonInput(output, 'Nexus actuator response')
      );
      if (!result) throw new Error('Invalid actuator response envelope.');
      if (result.ok === false) {
        logger.error(`❌ [Nexus] Slack API Error: ${result.error}`);
      } else {
        logger.success(`✅ [Nexus] Dispatch successful!`);
      }
    } catch (err: any) {
      logger.error(`❌ [Nexus] Dispatch failed: ${err.message}`);
    }
  } else {
    logger.info(
      `📝 [Nexus] Internal feedback for ${stimulus.id} (No connector): ${text.substring(0, 100)}...`
    );
  }
}

function extractBrainProfile(payload: string): { profile: string; cleanPayload: string } {
  const match = payload.match(/^\/([a-z0-9_-]+)\s+(.*)/is);
  if (match) {
    const profile = match[1].toLowerCase();
    const cleanPayload = match[2];

    try {
      const registryPath = pathResolver.resolve('knowledge/orchestration/brain-profiles.json');
      const safeRegistryPath = safeNexusPath(registryPath, true);
      if (safeExistsSync(safeRegistryPath)) {
        const registry = parseNexusBrainProfileRegistry(readNexusJson(safeRegistryPath));
        if (registry && Object.hasOwn(registry.profiles, profile)) {
          return { profile, cleanPayload };
        }
      }
    } catch (err) {
      logger.warn(`[nexus-daemon] suppressed error in extractBrainProfile: ${err}`);
    }
  }

  return { profile: 'default', cleanPayload: payload };
}

async function scanAndDispatch(channels: ChannelRegistryChannel[]) {
  const stimuliPath = safeNexusPath(STIMULI_PATH, true);
  const runtimeBase = safeNexusPath(RUNTIME_BASE, true);
  if (!isExistingRegularFile(stimuliPath)) return;

  const content = safeReadFile(stimuliPath, { encoding: 'utf8' }) as string;
  const allStimuli = content
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map(parseGuspStimulusLine)
    .filter((stimulus): stimulus is GuspStimulus => stimulus !== undefined);

  const injected = allStimuli.filter((s) => s.control.status === 'injected');

  for (const stimulus of injected) {
    if ((stimulus.policy?.feedback ?? stimulus.control.feedback) === 'silent') {
      await updateStimulusStatus(stimulus.id, 'processed', 'ignored_by_silent_policy');
      continue;
    }

    const sessions = isExistingDirectory(runtimeBase)
      ? safeReaddir(runtimeBase).filter((sid) => {
          try {
            return safeLstat(safeNexusPath(path.join(runtimeBase, sid))).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
    for (const sid of sessions) {
      const outDir = safeNexusPath(path.join(runtimeBase, sid, 'out'), true);
      const metaPath = safeNexusPath(path.join(outDir, 'latest_metadata.json'), true);
      const responsePath = safeNexusPath(path.join(outDir, 'latest_response.json'), true);

      if (isExistingRegularFile(metaPath) && isExistingRegularFile(responsePath)) {
        try {
          const meta = parseNexusSessionMetadata(readNexusJson(metaPath));
          if (meta?.stimulus_id === stimulus.id) {
            const response = parseNexusSessionResponse(readNexusJson(responsePath));
            if (!response) continue;
            const text =
              typeof response.message === 'string' && response.message.trim()
                ? response.message
                : JSON.stringify(response, null, 2);

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

  // Initialize Reflex Engine with a generic dispatcher.
  //
  // EV-03: the engine gates every reaction before this runs — the actuator must
  // be reflex-allowlisted, params placeholders are substituted structurally
  // (never by editing JSON text), and dispatch goes through TriggerRunner so the
  // same stimulus cannot fire the same reflex twice and each reaction leaves an
  // audit receipt. An actuator this dispatcher does not handle is now a load-time
  // rejection rather than a silent no-op here.
  reflexEngine.setDispatcher(async (actuator, action, params) => {
    logger.info(`⚡ [Nexus:Reflex] Executing autonomic reaction: ${actuator}.${action}`);
    if (actuator === 'service-actuator') {
      await dispatchService({
        service_id: params.service_id || 'slack',
        mode: 'API',
        action: action,
        params: params,
        auth: 'secret-guard',
      });
      return;
    }
    throw new Error(`[REFLEX] Nexus dispatcher cannot drive actuator "${actuator}"`);
  });

  while (true) {
    try {
      const channels = await loadNexusChannelRegistry();

      if (isExistingRegularFile(STIMULI_PATH)) {
        const stimuliPath = safeNexusPath(STIMULI_PATH);
        const content = safeReadFile(stimuliPath, { encoding: 'utf8' }) as string;
        const allStimuli = content
          .trim()
          .split('\n')
          .filter((l) => l.length > 0)
          .map(parseGuspStimulusLine)
          .filter((stimulus): stimulus is GuspStimulus => stimulus !== undefined);

        const pending = allStimuli.filter((s) => s.control.status === 'pending');

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
          const sessionSuffix = stimulus.origin.source_id
            .substring(stimulus.origin.source_id.length - 8)
            .toLowerCase();
          const targetSessionId = `${sessionPrefix}${sessionSuffix}`;

          logger.info(
            `🚀 [Nexus] Routing ${stimulus.id} to session ${targetSessionId} (Affinity: ${stimulus.origin.source_id})`
          );

          const { profile, cleanPayload } = extractBrainProfile(stimulus.signal.payload);

          const sessionInDir = safeNexusPath(path.join(RUNTIME_BASE, targetSessionId, 'in'), true);
          if (!safeExistsSync(sessionInDir)) safeMkdir(sessionInDir, { recursive: true });

          const metaInPath = safeNexusPath(path.join(sessionInDir, 'metadata.json'), true);
          safeWriteFile(
            metaInPath,
            JSON.stringify(
              {
                stimulus_id: stimulus.id,
                origin: stimulus.origin,
                policy: stimulus.policy,
                brain_profile: profile,
              },
              null,
              2
            )
          );

          const success = await terminalBridge.injectAndExecute(
            null as any,
            targetSessionId,
            cleanPayload,
            'ReflexTerminal'
          );
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

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

nexusLoop().catch((err) => {
  logger.error(`Nexus Daemon crashed: ${err.message}`);
  process.exit(1);
});
