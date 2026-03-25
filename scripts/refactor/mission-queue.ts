/**
 * scripts/refactor/mission-queue.ts
 * Queue persistence and dispatch selection for mission orchestration.
 */

import { logger, safeAppendFileSync, safeExistsSync, safeReadFile, safeWriteFile, withLock } from '@agent/core';

export interface MissionQueueEntry {
  mission_id: string;
  tier: string;
  priority: number;
  status: 'pending' | 'dispatched';
  enqueued_at: string;
  dependencies: string[];
}

export async function enqueueMission(
  queuePath: string,
  missionId: string,
  tier: string,
  priority = 5,
  deps: string[] = [],
): Promise<void> {
  const entry: MissionQueueEntry = {
    mission_id: missionId.toUpperCase(),
    tier,
    priority,
    status: 'pending',
    enqueued_at: new Date().toISOString(),
    dependencies: deps,
  };

  await withLock('mission-queue', async () => {
    safeAppendFileSync(queuePath, JSON.stringify(entry) + '\n');
  });
  logger.success(`📥 Mission ${entry.mission_id} added to queue (Priority: ${priority}).`);
}

export async function dispatchNextQueuedMission(
  queuePath: string,
  checkDependencies: (missionId: string) => { ok: boolean; missing: string[] },
  onDispatch: (missionId: string, tier: string) => Promise<void>,
): Promise<void> {
  await withLock('mission-queue', async () => {
    if (!safeExistsSync(queuePath)) {
      logger.info('Queue is empty.');
      return;
    }

    const lines = (safeReadFile(queuePath, { encoding: 'utf8' }) as string).split('\n').filter(Boolean);
    const queue = lines.map((line) => JSON.parse(line) as MissionQueueEntry);
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
      safeWriteFile(queuePath, queue.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      await onDispatch(mission.mission_id, mission.tier);
      return;
    }

    logger.info('No missions ready for dispatch (dependencies not met).');
  });
}
