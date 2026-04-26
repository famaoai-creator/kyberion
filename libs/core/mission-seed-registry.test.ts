import path from 'node:path';
import AjvModule from 'ajv';
import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeReaddir, safeRmSync } from './secure-io.js';
import { listMissionSeedRecords, loadMissionSeedRecord, saveMissionSeedRecord } from './mission-seed-registry.js';
import { buildOrganizationWorkLoopSummary } from './work-design.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

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
    const workLoop = buildOrganizationWorkLoopSummary({
      intentId: 'bootstrap-project',
      taskType: 'analysis',
      shape: 'project_bootstrap',
      tier: 'confidential',
      projectId: 'PRJ-TEST-WEB',
      locale: 'ja-JP',
      outcomeIds: ['project_created'],
      requiresApproval: false,
    });
    saveMissionSeedRecord({
      seed_id: 'MSD-TEST-ARCH',
      project_id: 'PRJ-TEST-WEB',
      track_id: 'TRK-TEST-REL1',
      track_name: 'Release 1',
      source_task_session_id: 'TSK-TEST-KICKOFF',
      source_work_id: 'WRK-TEST-ARCH',
      title: 'Design architecture',
      summary: 'Design the first architecture slice.',
      status: 'ready',
      specialist_id: 'document-specialist',
      mission_type_hint: 'architecture',
      locale: 'ja-JP',
      work_loop: workLoop,
      promoted_mission_id: 'MSN-TEST-ARCH',
      created_at: new Date().toISOString(),
    });
    expect(loadMissionSeedRecord('MSD-TEST-ARCH')?.project_id).toBe('PRJ-TEST-WEB');
    expect(loadMissionSeedRecord('MSD-TEST-ARCH')?.track_id).toBe('TRK-TEST-REL1');
    expect(loadMissionSeedRecord('MSD-TEST-ARCH')?.promoted_mission_id).toBe('MSN-TEST-ARCH');
    expect(loadMissionSeedRecord('MSD-TEST-ARCH')?.work_loop?.resolution.execution_shape).toBe('project_bootstrap');
    expect(listMissionSeedRecords().some((item) => item.seed_id === 'MSD-TEST-ARCH')).toBe(true);
  });

  it('emits mission seed records that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/public/schemas/mission-seed-record.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const record = {
      seed_id: 'MSD-TEST-SCHEMA',
      project_id: 'PRJ-TEST-WEB',
      title: 'Design architecture',
      summary: 'Design the first architecture slice.',
      status: 'ready',
      specialist_id: 'document-specialist',
      created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
    };
    const valid = validate(record);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
