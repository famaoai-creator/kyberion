import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { writeMissionStateAtPath } from './mission-state-reader.js';
import {
  checkDependencies,
  evaluateMissionPrerequisites,
  loadMissionStateIncludingArchive,
  normalizeMissionIdList,
  normalizeRelationships,
  saveState,
} from './mission-state.js';
import type { MissionState } from './mission-types.js';

const suffix = `${process.pid}-${Date.now().toString(36)}`.toUpperCase();
const ids = {
  done: `MSN-PREREQ-DONE-${suffix}`,
  archived: `MSN-PREREQ-ARCH-${suffix}`,
  active: `MSN-PREREQ-ACTIVE-${suffix}`,
  child: `MSN-PREREQ-CHILD-${suffix}`,
  missing: `MSN-PREREQ-MISSING-${suffix}`,
};
const created: string[] = [];

function state(missionId: string, status: string, prerequisites?: string[]): MissionState {
  return {
    mission_id: missionId,
    tier: 'public',
    status,
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: { branch: `mission/${missionId}`, start_commit: 'a', latest_commit: 'a', checkpoints: [] },
    history: [],
    ...(prerequisites ? { relationships: { prerequisites } } : {}),
  } as unknown as MissionState;
}

function writeActive(missionId: string, status: string, prerequisites?: string[]): void {
  const dir = pathResolver.missionDir(missionId, 'public');
  created.push(dir);
  writeMissionStateAtPath(
    path.join(dir, 'mission-state.json'),
    state(missionId, status, prerequisites)
  );
}

function writeArchived(missionId: string): void {
  const dir = pathResolver.archivedMissionDir(missionId);
  created.push(dir);
  writeMissionStateAtPath(path.join(dir, 'mission-state.json'), state(missionId, 'archived'));
}

let savedRole: string | undefined;
beforeAll(() => {
  savedRole = process.env.MISSION_ROLE;
  process.env.MISSION_ROLE = 'mission_controller';
});
afterAll(() => {
  if (savedRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = savedRole;
});

afterEach(() => {
  for (const dir of created.splice(0)) safeRmSync(dir, { recursive: true, force: true });
});

describe('mission prerequisites', () => {
  it('normalizes id lists from arrays and comma-separated strings', () => {
    expect(normalizeMissionIdList([' msn-a ', 'MSN-A', '', 'msn-b'])).toEqual(['MSN-A', 'MSN-B']);
    expect(normalizeMissionIdList('msn-a, msn-b,,')).toEqual(['MSN-A', 'MSN-B']);
    expect(normalizeMissionIdList(undefined)).toEqual([]);
    expect(
      normalizeRelationships({ prerequisites: ['msn-x', 'MSN-X'], blockers: 'msn-y' })
    ).toMatchObject({ prerequisites: ['MSN-X'], blockers: ['MSN-Y'] });
    // CLI overlays (--prerequisites / --relationships-json) merge with the
    // legacy positional relationships instead of being dropped.
    expect(
      normalizeRelationships(
        { prerequisites: ['msn-a'], successors: ['msn-s'] },
        { prerequisites: ['msn-b', 'MSN-A'], blockers: ['msn-c'] }
      )
    ).toMatchObject({
      prerequisites: ['MSN-A', 'MSN-B'],
      successors: ['MSN-S'],
      blockers: ['MSN-C'],
    });
  });

  it('treats completed and archived prerequisites as satisfied, wherever they live', () => {
    writeActive(ids.done, 'completed');
    writeArchived(ids.archived);
    writeActive(ids.active, 'active');

    expect(evaluateMissionPrerequisites([ids.done.toLowerCase(), ids.archived]).ok).toBe(true);
    expect(loadMissionStateIncludingArchive(ids.archived)?.status).toBe('archived');

    expect(evaluateMissionPrerequisites([ids.done, ids.active, ids.missing])).toEqual({
      ok: false,
      missing: [
        { mission_id: ids.active, reason: 'not_finished', status: 'active' },
        { mission_id: ids.missing, reason: 'not_found' },
      ],
    });
  });

  it('checkDependencies combines declared prerequisites with queue dependencies', () => {
    writeArchived(ids.archived);
    writeActive(ids.active, 'active');
    writeActive(ids.child, 'planned', [ids.archived]);

    expect(checkDependencies(ids.child)).toEqual({ ok: true, missing: [] });
    expect(checkDependencies(ids.child, [ids.active.toLowerCase()])).toEqual({
      ok: false,
      missing: [ids.active],
    });
  });

  it('saveState with missionDir writes there and never recreates the active path', async () => {
    const archiveDir = pathResolver.archivedMissionDir(ids.archived);
    created.push(archiveDir);
    await saveState(ids.archived, state(ids.archived, 'archived'), { missionDir: archiveDir });

    expect(safeExistsSync(path.join(archiveDir, 'mission-state.json'))).toBe(true);
    expect(safeExistsSync(pathResolver.missionDir(ids.archived, 'public'))).toBe(false);
    expect(loadMissionStateIncludingArchive(ids.archived)?.status).toBe('archived');
  });
});
