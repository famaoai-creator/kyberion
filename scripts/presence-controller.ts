import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, safeWriteFile, safeAppendFile, safeExistsSync } from '@agent/core';
import { safeExec } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import { readJsonFile, readTextFile } from './refactor/cli-input.js';

/**
 * Presence Controller v2.0 (Type-Safe TS Edition)
 */

interface Stimulus {
  timestamp: string;
  source_channel: string;
  delivery_mode: string;
  payload: string;
  status: 'PENDING' | 'INJECTED' | 'PROCESSED';
  metadata?: any;
  [key: string]: any;
}

interface Channel {
  id: string;
  name: string;
  priority: number;
}

interface ChannelRegistry {
  channels: Channel[];
}

export function perceive(): Stimulus[] {
  const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
  const REGISTRY_PATH = pathResolver.resolve('presence/bridge/channel-registry.json');

  if (!safeExistsSync(STIMULI_PATH)) return [];

  try {
    const content = readTextFile(STIMULI_PATH);
    const stimuli: Stimulus[] = content.trim().split('\n')
      .filter(l => l.length > 0)
      .map(line => JSON.parse(line))
      .filter(s => s.status === 'PENDING' || s.status === 'INJECTED');

    const registry: ChannelRegistry = readJsonFile(REGISTRY_PATH);
    const priorityMap = new Map(registry.channels.map(c => [c.id, c.priority]));

    return stimuli.sort((a, b) => {
      const pA = priorityMap.get(a.source_channel) || 0;
      const pB = priorityMap.get(b.source_channel) || 0;
      if (pB !== pA) return pB - pA;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
  } catch (err: any) {
    logger.error(`Perception Failure: ${err.message}`);
    return [];
  }
}

export function getSensoryContext(): string | null {
  const REGISTRY_PATH = pathResolver.resolve('presence/bridge/channel-registry.json');
  const pending = perceive();
  if (pending.length === 0) return null;

  const registry: ChannelRegistry = readJsonFile(REGISTRY_PATH);
  
  const formatted = pending.map(s => {
    const channel = registry.channels.find(c => c.id === s.source_channel) || { name: 'Unknown', priority: 0 };
    const priorityMark = channel.priority >= 8 ? ' [URGENT]' : '';
    return `- [Channel: ${channel.name}${priorityMark}] [Mode: ${s.delivery_mode}] Command: ${s.payload}`;
  });

  return `\n### 📡 SENSORY INTERVENTION DETECTED:\nThe following external signals are pending your attention. Please address high-priority (REALTIME) items immediately.\n\n${formatted.join('\n')}\n\n*Instructions: Mark items as processed by referencing their source and intent in your response.*`;
}

export async function resolveStimulus(timestamp: string, responseText: string = ''): Promise<void> {
  const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
  if (!safeExistsSync(STIMULI_PATH)) return;

  try {
    const content = readTextFile(STIMULI_PATH);
    let stimulusToReply: Stimulus | null = null;

    const lines = content.trim().split('\n').filter(l => l.length > 0).map(line => {
      const s: Stimulus = JSON.parse(line);
      if (s.timestamp === timestamp) {
        s.status = 'PROCESSED';
        s.resolved_at = new Date().toISOString();
        s.agent_response = responseText;
        stimulusToReply = s;
      }
      return JSON.stringify(s);
    });

    safeWriteFile(STIMULI_PATH, lines.join('\n') + '\n');

    if (stimulusToReply && responseText) {
      const s: Stimulus = stimulusToReply;
      if (s.source_channel === 'slack' && s.metadata) {
        const replyPayload = {
          action: 'message',
          channel: s.metadata.channel_id,
          thread_ts: s.metadata.thread_ts,
          input: responseText.replace(/\\n/g, '\n')
        };

        const tempInput = pathResolver.resolve(`active/shared/logs/slack_reply_${Date.now()}.json`);
        safeWriteFile(tempInput, JSON.stringify(replyPayload));
        
        try {
          safeExec('node', ['dist/scripts/cli.js', 'run', 'slack-communicator-pro', '--input', tempInput]);
          logger.success(`✅ [Presence Bridge] Reply sent via slack-communicator-pro.`);
        } catch (err: any) {
          logger.error(`❌ [Presence Bridge] Failed to send Slack reply: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    logger.error(`Resolution Failure: ${err.message}`);
  }
}

export async function pruneStimuli(): Promise<void> {
  const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
  if (!safeExistsSync(STIMULI_PATH)) return;

  try {
    const content = readTextFile(STIMULI_PATH);
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));

    const lines = content.trim().split('\n').filter(l => l.length > 0);
    const remaining: string[] = [];
    const archived: string[] = [];

    for (const line of lines) {
      const s: Stimulus = JSON.parse(line);
      const ts = new Date(s.timestamp);
      
      if (s.status === 'PROCESSED' && ts < oneDayAgo) {
        archived.push(line);
      } else {
        remaining.push(line);
      }
    }

    if (archived.length > 0) {
      const archiveDir = pathResolver.resolve('active/archive/presence');
      const archiveFile = path.join(archiveDir, `stimuli_archive_${now.toISOString().split('T')[0]}.jsonl`);
      
      if (!safeExistsSync(archiveDir)) safeWriteFile(path.join(archiveDir, '.gitkeep'), '');
      safeAppendFile(archiveFile, archived.join('\n') + '\n');
      safeWriteFile(STIMULI_PATH, remaining.join('\n') + '\n');
      logger.info(`🧹 Pruned ${archived.length} old stimuli to archive.`);
    }
  } catch (err: any) {
    logger.error(`Pruning Failure: ${err.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (action === 'resolve') {
    const ts = args[1];
    const resp = args[2] || '';
    if (!ts) process.exit(1);
    await resolveStimulus(ts, resp);
  } else if (action === 'perceive') {
    const pending = perceive();
    process.stdout.write(JSON.stringify(pending, null, 2));
  } else if (action === 'prune') {
    await pruneStimuli();
  }
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if ((entrypoint && modulePath === entrypoint) || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
