/**
 * D1 (customer decision E2E): a finished bolt is archived under the
 * protected confidential archive tier. The decision case resolver reads it
 * bound to the tenant (no MISSION_ROLE needed), never for another tenant, and
 * a policy denial is a distinct error — never "not found".
 */
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { loadDecisionCaseMissionState } from './mission-decision-lock.js';

const suffix = `${process.pid}${Date.now().toString(36)}`.toUpperCase();
const TENANT = 'cdten-archstate';
const MISSION = `MSN-CDARCH-${suffix}`;
const archiveDir = () =>
  pathResolver.archivedMissionDir(MISSION, { tier: 'confidential', tenant: TENANT });

function asMissionController<T>(fn: () => T): T {
  return withExecutionContext('mission_controller', fn, undefined, TENANT);
}

describe('loadDecisionCaseMissionState (archived confidential tenant mission)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of ['MISSION_ROLE', 'KYBERION_PERSONA', 'SYSTEM_ROLE', 'KYBERION_TENANT'])
      saved[key] = process.env[key];
    for (const key of Object.keys(saved)) delete process.env[key];
    asMissionController(() => {
      safeMkdir(archiveDir(), { recursive: true });
      safeWriteFile(
        path.join(archiveDir(), 'mission-state.json'),
        JSON.stringify({
          mission_id: MISSION,
          tier: 'confidential',
          tenant_slug: TENANT,
          status: 'archived',
          execution_mode: 'local',
          priority: 1,
          assigned_persona: 'tester',
          confidence_score: 1,
          git: { branch: 'test', start_commit: 'abc123', latest_commit: 'abc123', checkpoints: [] },
          history: [],
          relationships: { project: { project_id: 'PRJ-ARCH', relationship_type: 'belongs_to' } },
        })
      );
    });
  });
  afterEach(() => {
    delete process.env.SYSTEM_ROLE;
    vi.restoreAllMocks();
  });
  afterAll(() => {
    asMissionController(() => safeRmSync(archiveDir(), { recursive: true, force: true }));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reads it for its own tenant without MISSION_ROLE', () => {
    const state = loadDecisionCaseMissionState(MISSION, TENANT);
    expect(state?.status).toBe('archived');
    expect(state?.relationships?.project?.project_id).toBe('PRJ-ARCH');
  });

  it('is not visible to another tenant or without a tenant', () => {
    expect(loadDecisionCaseMissionState(MISSION, 'cdten-other')).toBeNull();
    expect(loadDecisionCaseMissionState(MISSION)).toBeNull();
  });

  it('a policy denial warns and throws MISSION_STATE_ACCESS_DENIED instead of "not found"', () => {
    // A surface that may assume no role (role-assumption-policy: customer_room).
    process.env.SYSTEM_ROLE = 'customer_room';
    const warn = vi.spyOn(logger, 'warn');
    expect(() => loadDecisionCaseMissionState(MISSION, TENANT)).toThrow(
      /\[MISSION_STATE_ACCESS_DENIED\]/u
    );
    const lines = warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => !line.startsWith('[locale]'));
    expect(lines.some((line) => /archived mission state not readable — .+ \| .+/u.test(line))).toBe(
      true
    );
  });
});
