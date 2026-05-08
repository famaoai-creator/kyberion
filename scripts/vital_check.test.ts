import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeRmSync, safeWriteFile } from '@agent/core';
import { activeMissionCount, buildVitalReport, fileCheck } from './vital_check.js';

const FIXTURE_ROOT = 'active/shared/tmp/tests/vital-check';
const ACTIVE_MISSION = path.join('active/missions/confidential', 'MSN-VITAL-ACTIVE-001');
const PERSONAL_MISSION = path.join('knowledge/personal/missions', 'MSN-VITAL-PERSONAL-001');

describe('vital_check', () => {
  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    safeRmSync(FIXTURE_ROOT);
    safeRmSync(ACTIVE_MISSION);
    safeRmSync(PERSONAL_MISSION);
  });

  afterEach(() => {
    safeRmSync(FIXTURE_ROOT);
    safeRmSync(ACTIVE_MISSION);
    safeRmSync(PERSONAL_MISSION);
    delete process.env.KYBERION_PERSONA;
    delete process.env.MISSION_ROLE;
  });

  it('checks file and directory targets through secure I/O', () => {
    safeWriteFile(path.join(FIXTURE_ROOT, 'file.txt'), 'ok', { encoding: 'utf8' });
    safeWriteFile(path.join(FIXTURE_ROOT, 'dir-only', '.keep'), 'ok', { encoding: 'utf8' });

    expect(
      fileCheck('fixture-file', 'Fixture File', path.join(FIXTURE_ROOT, 'file.txt'), 'file'),
    ).toMatchObject({ status: 'ok' });
    expect(
      fileCheck('fixture-dir', 'Fixture Dir', path.join(FIXTURE_ROOT, 'dir-only'), 'dir'),
    ).toMatchObject({ status: 'ok' });
  });

  it('counts active missions across both mission roots', () => {
    const before = activeMissionCount();

    safeWriteFile(
      path.join(ACTIVE_MISSION, 'mission-state.json'),
      JSON.stringify({ status: 'active' }, null, 2),
      { encoding: 'utf8' },
    );
    safeWriteFile(
      path.join(PERSONAL_MISSION, 'mission-state.json'),
      JSON.stringify({ status: 'active' }, null, 2),
      { encoding: 'utf8' },
    );

    expect(activeMissionCount()).toBe(before + 2);
  });

  it('builds a report that mirrors the mission count helper', () => {
    const report = buildVitalReport();
    expect(report.summary.total).toBe(9);
    expect(report.active_mission_count).toBe(activeMissionCount());
  });
});
