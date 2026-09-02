import * as path from 'node:path';
import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeAppendFile,
  safeExec,
  safeExistsSync,
  safeLstat,
  safeWriteFile,
} from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import {
  isRecord,
  nowIso,
  parseSafeJsonInput,
  readJson,
  readTextFile,
} from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Presence Controller v2.0 (Type-Safe TS Edition)
 */

interface Stimulus {
  timestamp: string;
  source_channel: string;
  delivery_mode: string;
  payload: string;
  status: 'PENDING' | 'INJECTED' | 'PROCESSED';
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Channel {
  id: string;
  name: string;
  priority: number;
}

interface ChannelRegistry {
  channels: Channel[];
}

export function parsePresenceStimulus(value: unknown): Stimulus | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.timestamp !== 'string' ||
    !value.timestamp.trim() ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.source_channel !== 'string' ||
    !value.source_channel.trim() ||
    typeof value.delivery_mode !== 'string' ||
    !value.delivery_mode.trim() ||
    typeof value.payload !== 'string' ||
    typeof value.status !== 'string' ||
    !['PENDING', 'INJECTED', 'PROCESSED'].includes(value.status)
  ) {
    return undefined;
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) return undefined;
  return value as unknown as Stimulus;
}

export function parsePresenceStimulusLine(line: string): Stimulus | undefined {
  try {
    return parsePresenceStimulus(parseSafeJsonInput(line, 'presence stimulus entry'));
  } catch {
    return undefined;
  }
}

export function resolvePresencePath(logicalPath: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.resolve(logicalPath), { allowMissingLeaf });
}

export function resolveExistingPresenceFile(logicalPath: string): string | null {
  try {
    const filePath = resolvePresencePath(logicalPath);
    return safeExistsSync(filePath) && safeLstat(filePath).isFile() ? filePath : null;
  } catch {
    return null;
  }
}

export function perceive(): Stimulus[] {
  const STIMULI_PATH = resolveExistingPresenceFile('presence/bridge/runtime/stimuli.jsonl');
  const REGISTRY_PATH = resolveExistingPresenceFile('presence/bridge/channel-registry.json');

  if (!STIMULI_PATH || !REGISTRY_PATH) return [];

  try {
    const content = readTextFile(STIMULI_PATH);
    const stimuli: Stimulus[] = content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map(parsePresenceStimulusLine)
      .filter((s): s is Stimulus => s?.status === 'PENDING' || s?.status === 'INJECTED');

    const registry: ChannelRegistry = readJson(REGISTRY_PATH);
    const priorityMap = new Map(registry.channels.map((c) => [c.id, c.priority]));

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
  const REGISTRY_PATH = resolveExistingPresenceFile('presence/bridge/channel-registry.json');
  const pending = perceive();
  if (pending.length === 0 || !REGISTRY_PATH) return null;

  const registry: ChannelRegistry = readJson(REGISTRY_PATH);

  const formatted = pending.map((s) => {
    const channel = registry.channels.find((c) => c.id === s.source_channel) || {
      name: 'Unknown',
      priority: 0,
    };
    const priorityMark = channel.priority >= 8 ? ' [URGENT]' : '';
    return `- [Channel: ${channel.name}${priorityMark}] [Mode: ${s.delivery_mode}] Command: ${s.payload}`;
  });

  return `\n### 📡 SENSORY INTERVENTION DETECTED:\nThe following external signals are pending your attention. Please address high-priority (REALTIME) items immediately.\n\n${formatted.join('\n')}\n\n*Instructions: Mark items as processed by referencing their source and intent in your response.*`;
}

export async function resolveStimulus(timestamp: string, responseText: string = ''): Promise<void> {
  const STIMULI_PATH = resolveExistingPresenceFile('presence/bridge/runtime/stimuli.jsonl');
  if (!STIMULI_PATH) return;

  try {
    const content = readTextFile(STIMULI_PATH);
    let stimulusToReply: Stimulus | null = null;

    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((line) => {
        const s = parsePresenceStimulusLine(line);
        if (!s) return line;
        if (s.timestamp === timestamp) {
          s.status = 'PROCESSED';
          s.resolved_at = nowIso();
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
          input: responseText.replace(/\\n/g, '\n'),
        };

        const tempInput = resolvePresencePath(`active/shared/logs/slack_reply_${Date.now()}.json`);
        safeWriteFile(tempInput, JSON.stringify(replyPayload));

        try {
          safeExec('node', [
            'dist/scripts/cli.js',
            'run',
            'slack-communicator-pro',
            '--input',
            tempInput,
          ]);
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
  const STIMULI_PATH = resolveExistingPresenceFile('presence/bridge/runtime/stimuli.jsonl');
  if (!STIMULI_PATH) return;

  try {
    const content = readTextFile(STIMULI_PATH);
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    const remaining: string[] = [];
    const archived: string[] = [];

    for (const line of lines) {
      const s = parsePresenceStimulusLine(line);
      if (!s) {
        remaining.push(line);
        continue;
      }
      const ts = new Date(s.timestamp);

      if (s.status === 'PROCESSED' && ts < oneDayAgo) {
        archived.push(line);
      } else {
        remaining.push(line);
      }
    }

    if (archived.length > 0) {
      const archiveDir = resolvePresencePath('active/archive/presence');
      const archiveFile = assertSafeRepositoryPath(
        path.join(archiveDir, `stimuli_archive_${now.toISOString().split('T')[0]}.jsonl`),
        { allowMissingLeaf: true }
      );

      if (!safeExistsSync(archiveDir)) {
        safeWriteFile(
          assertSafeRepositoryPath(path.join(archiveDir, '.gitkeep'), { allowMissingLeaf: true }),
          ''
        );
      }
      safeAppendFile(archiveFile, archived.join('\n') + '\n');
      safeWriteFile(STIMULI_PATH, remaining.join('\n') + '\n');
      logger.info(`🧹 Pruned ${archived.length} old stimuli to archive.`);
    }
  } catch (err: any) {
    logger.error(`Pruning Failure: ${err.message}`);
  }
}

function printUsage(): void {
  console.log('Usage: pnpm presence-controller <resolve|perceive|prune> [args]');
}

export async function main(args: string[] = []): Promise<void> {
  const action = args[0];

  if (!action || action === '--help' || action === '-h' || action === 'help') {
    printUsage();
    return;
  }

  if (action === 'resolve') {
    const ts = args[1];
    const resp = args[2] || '';
    if (!ts) throw new ScriptExitError(1, 'resolve requires a stimulus timestamp');
    await resolveStimulus(ts, resp);
  } else if (action === 'perceive') {
    const pending = perceive();
    process.stdout.write(JSON.stringify(pending, null, 2));
  } else if (action === 'prune') {
    await pruneStimuli();
  }
}

export const runPresenceController = defineScript({
  name: 'presence:controller',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'presence-controller.ts') ||
  isDirectScript(import.meta.url, 'presence-controller.js')
)
  void runPresenceController();
