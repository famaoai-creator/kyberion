import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir, safeRmSync } from './secure-io.js';
import { listMissionSeedRecords, loadMissionSeedRecord, saveMissionSeedRecord } from './mission-seed-registry.js';

function cleanupByPrefix(dir: string, prefix: string) {
  if (!safeExistsSync(dir)) return;
  for (const entry of safeReaddir(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
    safeRmSync(`${dir}/${entry}`);
  }
}

describe('mission-seed-registry', () => {
  beforeEach(() => {
    cleanupByPrefix(pathResolver.shared('runtime/mission-seeds'), 'MSD-TEST-');
  });

  it('persists mission seed records for bootstrap follow-up work', () => {
    saveMissionSeedRecord({
      seed_id: 'MSD-TEST-ARCH',
      project_id: 'PRJ-TEST-WEB',
      source_task_session_id: 'TSK-TEST-KICKOFF',
      source_work_id: 'WRK-TEST-ARCH',
      title: 'Design architecture',
      summary: 'Design the first architecture slice.',
      status: 'ready',
      specialist_id: 'document-specialist',
      mission_type_hint: 'architecture',
      locale: 'ja-JP',
      promoted_mission_id: 'MSN-TEST-ARCH',
      created_at: new Date().toISOString(),
    });
    expect(loadMissionSeedRecord('MSD-TEST-ARCH')?.project_id).toBe('PRJ-TEST-WEB');
    expect(loadMissionSeedRecord('MSD-TEST-ARCH')?.promoted_mission_id).toBe('MSN-TEST-ARCH');
    expect(listMissionSeedRecords().some((item) => item.seed_id === 'MSD-TEST-ARCH')).toBe(true);
  });
});
