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
import { appendJsonLine, isRecord, nowIso, readJsonLines } from '@agent/core/foundation';
import { assertValidMissionIdList, normalizeMissionIdList } from './mission-state.js';

/** A start that fails this many times is parked as `failed` instead of blocking the queue. */
export const MAX_DISPATCH_ATTEMPTS = 3;

export interface MissionQueueEntry {
  mission_id: string;
  tier: 'personal' | 'confidential' | 'public';
  priority: number;
  status: 'pending' | 'dispatched' | 'failed';
  enqueued_at: string;
  dependencies: string[];
  metadata?: { dispatch_attempts?: number; last_error?: string; last_attempt_at?: string };
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

    const queue = readJsonLines<unknown>(resolvedQueuePath, { onMalformed: 'skip' }).flatMap(
      (value) => {
        const entry = parseMissionQueueEntry(value);
        return entry ? [entry] : [];
      }
    );
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
        safeWriteFile(
          resolvedQueuePath,
          queue.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        );
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
      const persist = () =>
        safeWriteFile(
          resolvedQueuePath,
          queue.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        );
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
      persist();
      return;
    }

    logger.info('No missions ready for dispatch (dependencies not met).');
  });
}
