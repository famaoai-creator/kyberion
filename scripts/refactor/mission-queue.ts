/**
 * scripts/refactor/mission-queue.ts
 * Queue persistence and dispatch selection for mission orchestration.
 */

import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeWriteFile,
} from '@agent/core/secure-io';
import { withLock } from '@agent/core/lock-utils';
import { appendJsonLine, isRecord, nowIso } from '@agent/core/foundation';
import { streamJsonLines } from '@agent/core/jsonl-read';
import {
  assertValidMissionIdList,
  normalizeMissionIdList,
} from '@agent/core/mission/mission-state';

/** A start that fails this many times is parked as `failed` instead of blocking the queue. */
export const MAX_DISPATCH_ATTEMPTS = 3;

/**
 * Terminal (`dispatched` / `failed`) rows older than this are pruned when the
 * queue is rewritten. Only this module reads the queue, and it only acts on
 * `pending` rows; terminal rows are kept for a while so an operator can see
 * what was recently dispatched or parked.
 */
export const MISSION_QUEUE_TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export interface MissionQueueEntry {
  mission_id: string;
  tier: 'personal' | 'confidential' | 'public';
  priority: number;
  status: 'pending' | 'dispatched' | 'failed';
  enqueued_at: string;
  dependencies: string[];
  metadata?: {
    dispatch_attempts?: number;
    last_error?: string;
    last_attempt_at?: string;
    dispatched_at?: string;
  };
}

function isTerminal(entry: MissionQueueEntry): boolean {
  return entry.status === 'dispatched' || entry.status === 'failed';
}

/** When the row became terminal: dispatch time, last attempt, else enqueue time. */
function terminalAtMs(entry: MissionQueueEntry): number {
  for (const candidate of [
    entry.metadata?.dispatched_at,
    entry.metadata?.last_attempt_at,
    entry.enqueued_at,
  ]) {
    const ms = typeof candidate === 'string' ? Date.parse(candidate) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return Number.NaN;
}

/**
 * Rows to keep on a rewrite: every non-terminal row, and terminal rows newer
 * than `retentionMs` (or whose age is unknown). Order is preserved.
 */
export function pruneMissionQueue(
  queue: MissionQueueEntry[],
  nowMs: number = Date.now(),
  retentionMs: number = MISSION_QUEUE_TERMINAL_RETENTION_MS
): MissionQueueEntry[] {
  return queue.filter((entry) => {
    if (!isTerminal(entry)) return true;
    const at = terminalAtMs(entry);
    return !Number.isFinite(at) || nowMs - at < retentionMs;
  });
}

function writeMissionQueue(resolvedQueuePath: string, queue: MissionQueueEntry[]): void {
  const kept = pruneMissionQueue(queue);
  safeWriteFile(
    resolvedQueuePath,
    kept.length ? kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n' : ''
  );
}

function parseMissionQueueEntry(value: unknown): MissionQueueEntry | null {
  if (!isRecord(value)) return null;
  const missionId = value.mission_id;
  const tier = value.tier;
  const priority = value.priority;
  const status = value.status;
  const enqueuedAt = value.enqueued_at;
  const dependencies = value.dependencies;
  let normalizedPriority = 5;
  if (
    priority !== undefined &&
    (typeof priority !== 'number' || !Number.isInteger(priority) || !Number.isFinite(priority))
  ) {
    return null;
  }
  if (typeof priority === 'number') normalizedPriority = priority;

  let normalizedDependencies: string[] = [];
  if (
    dependencies !== undefined &&
    (!Array.isArray(dependencies) ||
      dependencies.some((dependency) => typeof dependency !== 'string'))
  ) {
    return null;
  }
  if (Array.isArray(dependencies)) normalizedDependencies = dependencies;

  if (
    typeof missionId !== 'string' ||
    !missionId.trim() ||
    (tier !== 'personal' && tier !== 'confidential' && tier !== 'public') ||
    (status !== 'pending' && status !== 'dispatched' && status !== 'failed') ||
    typeof enqueuedAt !== 'string' ||
    !enqueuedAt.trim() ||
    !Number.isFinite(Date.parse(enqueuedAt))
  ) {
    return null;
  }

  return {
    mission_id: missionId.trim(),
    tier,
    priority: normalizedPriority,
    status,
    enqueued_at: enqueuedAt,
    dependencies: normalizedDependencies,
    ...(isRecord(value.metadata)
      ? { metadata: value.metadata as MissionQueueEntry['metadata'] }
      : {}),
  };
}

function resolveMissionQueuePath(queuePath: string): string {
  const resolved = assertSafeRepositoryPath(queuePath, { allowMissingLeaf: true });
  if (safeExistsSync(resolved) && !safeLstat(resolved).isFile()) {
    throw new Error(`Mission queue must be an existing regular file: ${queuePath}`);
  }
  return resolved;
}

export async function enqueueMission(
  queuePath: string,
  missionId: string,
  tier: MissionQueueEntry['tier'],
  priority = 5,
  deps: string[] = []
): Promise<void> {
  const entry: MissionQueueEntry = {
    mission_id: assertValidMissionIdList([missionId.trim().toUpperCase()], 'mission id')[0]!,
    tier,
    priority,
    status: 'pending',
    enqueued_at: nowIso(),
    dependencies: assertValidMissionIdList(normalizeMissionIdList(deps), 'dependencies'),
  };

  await withLock('mission-queue', async () => {
    appendJsonLine(resolveMissionQueuePath(queuePath), entry);
  });
  logger.success(`📥 Mission ${entry.mission_id} added to queue (Priority: ${priority}).`);
}

export async function dispatchNextQueuedMission(
  queuePath: string,
  checkDependencies: (
    missionId: string,
    queueDependencies: string[]
  ) => { ok: boolean; missing: string[] },
  onDispatch: (missionId: string, tier: MissionQueueEntry['tier']) => Promise<void>
): Promise<void> {
  await withLock('mission-queue', async () => {
    const resolvedQueuePath = resolveMissionQueuePath(queuePath);
    if (!safeExistsSync(resolvedQueuePath)) {
      logger.info('Queue is empty.');
      return;
    }

    const queue: MissionQueueEntry[] = [];
    for (const value of streamJsonLines<unknown>(resolvedQueuePath, { onMalformed: 'skip' })) {
      const entry = parseMissionQueueEntry(value);
      if (entry) queue.push(entry);
    }
    const pending = queue.filter((mission) => mission.status === 'pending');

    if (pending.length === 0) {
      logger.info('No pending missions in queue.');
      return;
    }

    pending.sort((a, b) => b.priority - a.priority || a.enqueued_at.localeCompare(b.enqueued_at));

    for (const mission of pending) {
      let readiness: { ok: boolean; missing: string[] };
      try {
        readiness = checkDependencies(mission.mission_id, mission.dependencies || []);
      } catch (error) {
        // e.g. an entry written before enqueue validated ids: park it instead
        // of throwing on every dispatch.
        mission.status = 'failed';
        mission.metadata = {
          ...(mission.metadata || {}),
          last_error: error instanceof Error ? error.message : String(error),
          last_attempt_at: nowIso(),
        };
        writeMissionQueue(resolvedQueuePath, queue);
        logger.warn(
          `Queue entry ${mission.mission_id} is unreadable and was parked as failed — ${mission.metadata.last_error} ` +
            `| next: re-enqueue with a valid id | evidence: ${resolvedQueuePath}`
        );
        continue;
      }
      const { ok, missing } = readiness;
      if (!ok) {
        logger.info(`⏳ Skipping ${mission.mission_id}: waiting for ${missing.join(', ')}`);
        continue;
      }

      logger.info(`🚀 Dispatching Mission: ${mission.mission_id}...`);
      const persist = () => writeMissionQueue(resolvedQueuePath, queue);
      // Mark dispatched only after start succeeded. A failed start stays
      // pending for a retry, and is parked as failed after
      // MAX_DISPATCH_ATTEMPTS so it cannot block the rest of the queue.
      try {
        await onDispatch(mission.mission_id, mission.tier);
      } catch (error) {
        const attempts = (mission.metadata?.dispatch_attempts || 0) + 1;
        mission.metadata = {
          ...(mission.metadata || {}),
          dispatch_attempts: attempts,
          last_error: error instanceof Error ? error.message : String(error),
          last_attempt_at: nowIso(),
        };
        if (attempts >= MAX_DISPATCH_ATTEMPTS) mission.status = 'failed';
        persist();
        logger.warn(
          `Queue entry ${mission.mission_id} failed to start (attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS})` +
            (mission.status === 'failed' ? ' — parked as failed' : ' — kept pending') +
            ` | next: fix the cause, then dispatch again | evidence: ${resolvedQueuePath}`
        );
        throw error;
      }
      mission.status = 'dispatched';
      mission.metadata = { ...(mission.metadata || {}), dispatched_at: nowIso() };
      persist();
      return;
    }

    logger.info('No missions ready for dispatch (dependencies not met).');
  });
}
