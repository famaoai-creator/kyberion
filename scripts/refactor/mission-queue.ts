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

export interface MissionQueueEntry {
  mission_id: string;
  tier: 'personal' | 'confidential' | 'public';
  priority: number;
  status: 'pending' | 'dispatched';
  enqueued_at: string;
  dependencies: string[];
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
    (status !== 'pending' && status !== 'dispatched') ||
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
    mission_id: missionId.toUpperCase(),
    tier,
    priority,
    status: 'pending',
    enqueued_at: nowIso(),
    dependencies: deps,
  };

  await withLock('mission-queue', async () => {
    appendJsonLine(resolveMissionQueuePath(queuePath), entry);
  });
  logger.success(`📥 Mission ${entry.mission_id} added to queue (Priority: ${priority}).`);
}

export async function dispatchNextQueuedMission(
  queuePath: string,
  checkDependencies: (missionId: string) => { ok: boolean; missing: string[] },
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
      const { ok, missing } = checkDependencies(mission.mission_id);
      if (!ok) {
        logger.info(`⏳ Skipping ${mission.mission_id}: Waiting for ${missing.join(', ')}`);
        continue;
      }

      logger.info(`🚀 Dispatching Mission: ${mission.mission_id}...`);
      mission.status = 'dispatched';
      safeWriteFile(
        resolvedQueuePath,
        queue.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
      );
      await onDispatch(mission.mission_id, mission.tier);
      return;
    }

    logger.info('No missions ready for dispatch (dependencies not met).');
  });
}
