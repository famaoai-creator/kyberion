import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeRmSync, safeWriteFile } from '@agent/core';
import { activeMissionCount, buildVitalReport, fileCheck } from './vital_check.js';

const FIXTURE_ROOT = 'active/shared/tmp/tests/vital-check';
const ACTIVE_MISSION = path.join('active/missions/confidential', 'MSN-VITAL-ACTIVE-001');
const PERSONAL_MISSION = path.join('knowledge/personal/missions', 'MSN-VITAL-PERSONAL-001');
const CUSTOMER_SLUG = 'vital-check-customer';
const CUSTOMER_OVERLAY_ROOT = pathResolver.sharedTmp('tests/vital-check/customer-overlay');

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
  return {
    ...actual,
    customerResolver: {
      ...actual.customerResolver,
      customerRoot: (subPath = '') => (subPath ? path.join(CUSTOMER_OVERLAY_ROOT, subPath) : CUSTOMER_OVERLAY_ROOT),
    },
  };
});

describe('vital_check', () => {
  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_CUSTOMER = CUSTOMER_SLUG;
    safeRmSync(FIXTURE_ROOT);
    safeRmSync(ACTIVE_MISSION);
    safeRmSync(PERSONAL_MISSION);
    safeRmSync(CUSTOMER_OVERLAY_ROOT);
  });

  afterEach(() => {
    safeRmSync(FIXTURE_ROOT);
    safeRmSync(ACTIVE_MISSION);
    safeRmSync(PERSONAL_MISSION);
    safeRmSync(CUSTOMER_OVERLAY_ROOT);
    delete process.env.KYBERION_PERSONA;
    delete process.env.MISSION_ROLE;
    delete process.env.KYBERION_CUSTOMER;
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
    expect(report.summary.total).toBe(10);
    expect(report.active_mission_count).toBe(activeMissionCount());
  });

  it('prefers customer overlay identity and onboarding artifacts when active', () => {
    safeWriteFile(
      path.join(CUSTOMER_OVERLAY_ROOT, 'my-identity.json'),
      JSON.stringify({ name: 'Customer Sovereign' }, null, 2),
      { encoding: 'utf8' },
    );
    safeWriteFile(
      path.join(CUSTOMER_OVERLAY_ROOT, 'my-vision.md'),
      '# Customer Vision\n\nBuild for the customer overlay.\n',
      { encoding: 'utf8' },
    );
    safeWriteFile(
      path.join(CUSTOMER_OVERLAY_ROOT, 'agent-identity.json'),
      JSON.stringify({ agent_id: 'CUSTOMER-PRIME' }, null, 2),
      { encoding: 'utf8' },
    );
    safeWriteFile(
      path.join(CUSTOMER_OVERLAY_ROOT, 'onboarding/onboarding-summary.md'),
      '# Customer Onboarding Summary\n',
      { encoding: 'utf8' },
    );

    const report = buildVitalReport();
    const identity = report.checks.find((check) => check.id === 'sovereign_identity');
    const agentIdentity = report.checks.find((check) => check.id === 'agent_identity');
    const vision = report.checks.find((check) => check.id === 'sovereign_vision');
    const summary = report.checks.find((check) => check.id === 'onboarding_summary');

    expect(identity?.detail).toContain(path.join(CUSTOMER_OVERLAY_ROOT, 'my-identity.json'));
    expect(agentIdentity?.detail).toContain(path.join(CUSTOMER_OVERLAY_ROOT, 'agent-identity.json'));
    expect(vision?.detail).toContain(path.join(CUSTOMER_OVERLAY_ROOT, 'my-vision.md'));
    expect(summary?.detail).toContain(path.join(CUSTOMER_OVERLAY_ROOT, 'onboarding/onboarding-summary.md'));
  });
});
