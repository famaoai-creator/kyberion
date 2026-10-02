import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { writeMissionStateAtPath } from '../mission/mission-state-reader.js';
import type { MissionState } from '../mission/mission-types.js';
import {
  appendArtifactOwnershipRecord,
  artifactOwnershipRegistryPath,
} from '../workforce/artifact-registry.js';
import { getProjectManagementView } from './project-management.js';
import { deriveProjectMissionIndex, projectArtifactRecords } from './project-mission-index.js';
import {
  loadProjectOperationalState,
  projectOperationalMissionLinkPath,
  projectOperationalTrackStatePath,
  syncProjectOperationalStateFromMission,
} from './project-operational-state-registry.js';
import { loadProjectRecord, projectRecordPath, saveProjectRecord } from './project-registry.js';
import { saveProjectTrackRecord } from './project-track-registry.js';
import { readJson } from '../foundation/json.js';

const suffix = `${process.pid}-${Date.now().toString(36)}`.toUpperCase();
const PROJECT_ID = `PRJ-LINK-IDX-${suffix}`;
const TRACK_ID = `TRK-LINK-IDX-${suffix}`;
const M1 = `MSN-LINK-IDX-A-${suffix}`;
const M2 = `MSN-LINK-IDX-B-${suffix}`;
const created: string[] = [];
const savedEnv = { persona: process.env.KYBERION_PERSONA, role: process.env.MISSION_ROLE };

function mission(id: string, status: string): MissionState {
  return {
    mission_id: id,
    tier: 'public',
    status,
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: { branch: `mission/${id}`, start_commit: 'a', latest_commit: 'a', checkpoints: [] },
    history: [],
    relationships: {
      project: {
        relationship_type: 'belongs_to',
        project_id: PROJECT_ID,
        affected_artifacts: [],
        gate_impact: 'none',
        traceability_refs: [],
      },
      track: { relationship_type: 'belongs_to', track_id: TRACK_ID, traceability_refs: [] },
    },
  } as unknown as MissionState;
}

function writeAt(dir: string, state: MissionState): void {
  created.push(dir);
  writeMissionStateAtPath(path.join(dir, 'mission-state.json'), state);
}

function sync(state: MissionState): void {
  syncProjectOperationalStateFromMission({
    mission_id: state.mission_id,
    tier: state.tier,
    status: state.status,
    relationships: state.relationships,
  } as Parameters<typeof syncProjectOperationalStateFromMission>[0]);
}

beforeEach(() => {
  process.env.KYBERION_PERSONA = 'ecosystem_architect';
  process.env.MISSION_ROLE = 'mission_controller';
  created.push(pathResolver.projectWorkspaceDir(PROJECT_ID, 'public', 'shared'));
  created.push(projectRecordPath(PROJECT_ID));
  saveProjectRecord({
    project_id: PROJECT_ID,
    name: 'Link index test',
    summary: 'Project membership derived from mission state.',
    status: 'active',
    tier: 'public',
    active_missions: ['MSN-STALE-ENTRY'],
  } as Parameters<typeof saveProjectRecord>[0]);
});

afterEach(() => {
  for (const target of created.splice(0)) safeRmSync(target, { recursive: true, force: true });
  process.env.KYBERION_PERSONA = savedEnv.persona;
  process.env.MISSION_ROLE = savedEnv.role;
});

describe('project mission index (single source: relationships.project)', () => {
  it('keeps every active mission of a track and drops finished ones', () => {
    writeAt(pathResolver.missionDir(M1, 'public'), mission(M1, 'active'));
    writeAt(pathResolver.missionDir(M2, 'public'), mission(M2, 'active'));
    sync(mission(M1, 'active'));
    sync(mission(M2, 'active'));

    const trackState = readJson<{ active_mission_ids: string[]; status: string }>(
      projectOperationalTrackStatePath(PROJECT_ID, 'public', undefined, TRACK_ID)
    );
    // Before: the track was overwritten with only the last-synced mission.
    expect(trackState.active_mission_ids).toEqual([M1, M2].sort());
    expect(loadProjectOperationalState(PROJECT_ID, 'public')?.active_mission_ids).toEqual(
      [M1, M2].sort()
    );

    // M1 finishes: it moves to the archive and syncs as archived.
    safeRmSync(pathResolver.missionDir(M1, 'public'), { recursive: true, force: true });
    writeAt(pathResolver.archivedMissionDir(M1), mission(M1, 'archived'));
    sync(mission(M1, 'archived'));

    const state = loadProjectOperationalState(PROJECT_ID, 'public');
    expect(state?.active_mission_ids).toEqual([M2]);
    expect(state?.active_track_ids).toEqual([TRACK_ID]);
    const trackAfter = readJson<{ active_mission_ids: string[]; status: string }>(
      projectOperationalTrackStatePath(PROJECT_ID, 'public', undefined, TRACK_ID)
    );
    expect(trackAfter).toMatchObject({ active_mission_ids: [M2], status: 'active' });
    // The project record is a projection of the same index (stale entry gone).
    expect(loadProjectRecord(PROJECT_ID)?.active_missions).toEqual([M2]);
    // mission-link.json is retired.
    expect(
      safeExistsSync(projectOperationalMissionLinkPath(PROJECT_ID, 'public', undefined, M1))
    ).toBe(false);
  });

  it('syncs under the worker persona the mission CLI runs as (no skipped sync, siblings kept)', () => {
    // E2E regression: the post-start sync ran as persona worker + role
    // mission_controller; it used to be skipped (policy) and, through the
    // worker-scoped projectMissions view, would have dropped sibling missions.
    process.env.KYBERION_PERSONA = 'worker';
    writeAt(pathResolver.missionDir(M1, 'public'), mission(M1, 'active'));
    writeAt(pathResolver.missionDir(M2, 'public'), mission(M2, 'active'));
    sync(mission(M2, 'active'));
    expect(loadProjectOperationalState(PROJECT_ID, 'public')?.active_mission_ids).toEqual(
      [M1, M2].sort()
    );
    expect(loadProjectRecord(PROJECT_ID)?.active_missions).toEqual([M1, M2].sort());
  });

  function trackState(id: string): { active_mission_ids: string[]; status: string } {
    return readJson(projectOperationalTrackStatePath(PROJECT_ID, 'public', undefined, id));
  }

  it('keeps a registered active track with no missions (same rule as reconcile)', () => {
    const emptyTrack = `TRK-LINK-IDX-EMPTY-${suffix}`;
    created.push(pathResolver.shared(`runtime/project-tracks/${emptyTrack}.json`));
    saveProjectTrackRecord({
      track_id: emptyTrack,
      project_id: PROJECT_ID,
      name: 'Empty lane',
      summary: 'Registered, no missions yet',
      status: 'active',
      track_type: 'delivery',
      lifecycle_model: 'sdlc',
      tier: 'public',
    } as Parameters<typeof saveProjectTrackRecord>[0]);
    writeAt(pathResolver.missionDir(M1, 'public'), mission(M1, 'active'));
    sync(mission(M1, 'active'));
    expect(loadProjectOperationalState(PROJECT_ID, 'public')?.active_track_ids).toEqual(
      [TRACK_ID, emptyTrack].sort()
    );
    expect(loadProjectRecord(PROJECT_ID)?.active_tracks).toEqual([TRACK_ID, emptyTrack].sort());
  });

  it('marks a track failed when its last mission fails, and rebuilds a track a mission left', () => {
    writeAt(pathResolver.missionDir(M1, 'public'), mission(M1, 'active'));
    sync(mission(M1, 'active'));
    writeAt(pathResolver.missionDir(M1, 'public'), mission(M1, 'failed'));
    sync(mission(M1, 'failed'));
    expect(trackState(TRACK_ID)).toMatchObject({ status: 'failed', active_mission_ids: [] });

    // M2 starts on TRACK_ID, then moves to another track.
    writeAt(pathResolver.missionDir(M2, 'public'), mission(M2, 'active'));
    sync(mission(M2, 'active'));
    expect(trackState(TRACK_ID).active_mission_ids).toEqual([M2]);
    const moved = mission(M2, 'active');
    const otherTrack = `TRK-LINK-IDX-OTHER-${suffix}`;
    (moved.relationships as { track: { track_id: string } }).track.track_id = otherTrack;
    writeAt(pathResolver.missionDir(M2, 'public'), moved);
    sync(moved);
    expect(trackState(TRACK_ID).active_mission_ids).toEqual([]);
    expect(trackState(otherTrack).active_mission_ids).toEqual([M2]);
  });

  it('finds confidential tenant missions in their tenant directory', () => {
    const confidential = {
      ...mission(M1, 'active'),
      tier: 'confidential',
      tenant_slug: 'acme-idx',
    } as MissionState;
    writeAt(pathResolver.missionDir(M1, 'confidential', 'acme-idx'), confidential);
    expect(
      deriveProjectMissionIndex(PROJECT_ID, { tier: 'confidential', tenant: 'acme-idx' })
        .activeMissionIds
    ).toEqual([M1]);
    expect(
      deriveProjectMissionIndex(PROJECT_ID, { tier: 'confidential', tenant: 'other-idx' }).linked
    ).toEqual([]);
  });

  it("excludes another tenant's artifact records", () => {
    const registryPath = artifactOwnershipRegistryPath();
    const original = safeExistsSync(registryPath)
      ? (safeReadFile(registryPath, { encoding: 'utf8' }) as string)
      : null;
    try {
      const base = {
        kind: 'report' as const,
        storage_class: 'artifact_store' as const,
        project_id: PROJECT_ID,
        created_at: new Date().toISOString(),
        evidence_refs: [],
      };
      appendArtifactOwnershipRecord({ ...base, artifact_id: `ART-OWN-${suffix}` });
      appendArtifactOwnershipRecord({
        ...base,
        artifact_id: `ART-OTHER-${suffix}`,
        tenant_slug: 'other-tenant',
      });
      const ids = projectArtifactRecords(PROJECT_ID, { tier: 'public', tenant: 'shared' }, []).map(
        (record) => record.artifact_id
      );
      expect(ids).toContain(`ART-OWN-${suffix}`);
      expect(ids).not.toContain(`ART-OTHER-${suffix}`);

      // A re-registered artifact (mission deliverable promoted to the project)
      // is listed once, at its latest path.
      appendArtifactOwnershipRecord({
        ...base,
        artifact_id: `ART-OWN-${suffix}`,
        path: 'active/projects/public/shared/p/artifacts/report/missions/M/x.md',
      });
      const own = projectArtifactRecords(
        PROJECT_ID,
        { tier: 'public', tenant: 'shared' },
        []
      ).filter((record) => record.artifact_id === `ART-OWN-${suffix}`);
      expect(own.map((record) => record.path)).toEqual([
        'active/projects/public/shared/p/artifacts/report/missions/M/x.md',
      ]);

      // A record carrying another tier never surfaces in this project's view.
      appendArtifactOwnershipRecord({
        ...base,
        artifact_id: `ART-CONF-${suffix}`,
        metadata: { tier: 'confidential' },
      });
      expect(
        projectArtifactRecords(PROJECT_ID, { tier: 'public', tenant: 'shared' }, []).map(
          (record) => record.artifact_id
        )
      ).not.toContain(`ART-CONF-${suffix}`);
      // Where the file lives wins over an older defaulted metadata tier.
      appendArtifactOwnershipRecord({
        ...base,
        artifact_id: `ART-LEGACY-${suffix}`,
        path: 'active/missions/public/MSN-OLD/artifacts/report/x.md',
        metadata: { tier: 'confidential' },
      });
      expect(
        projectArtifactRecords(PROJECT_ID, { tier: 'public', tenant: 'shared' }, []).map(
          (record) => record.artifact_id
        )
      ).toContain(`ART-LEGACY-${suffix}`);
    } finally {
      if (original === null) safeRmSync(registryPath, { force: true });
      else safeWriteFile(registryPath, original);
    }
  });

  it("never writes project state from a mission outside the project's scope", () => {
    // PROJECT_ID is public/shared; a confidential tenant mission linked to it
    // (a legacy link) must not create project state in its own partition.
    const foreignState = {
      ...mission(M1, 'active'),
      tier: 'confidential',
      tenant_slug: 'acme-scope',
    } as MissionState;
    const result = syncProjectOperationalStateFromMission({
      mission_id: foreignState.mission_id,
      tier: foreignState.tier,
      tenant_slug: 'acme-scope',
      status: foreignState.status,
      relationships: foreignState.relationships,
    } as Parameters<typeof syncProjectOperationalStateFromMission>[0]);
    expect(result).toBeNull();
    expect(
      safeExistsSync(pathResolver.projectWorkspaceDir(PROJECT_ID, 'confidential', 'acme-scope'))
    ).toBe(false);
  });

  it('derives the index from mission state only, scoped by tier/tenant', () => {
    writeAt(pathResolver.missionDir(M1, 'public'), mission(M1, 'paused'));
    writeAt(pathResolver.missionDir(M2, 'public'), mission(M2, 'completed'));
    const index = deriveProjectMissionIndex(PROJECT_ID, { tier: 'public', tenant: 'shared' });
    expect(index.linked.map((entry) => entry.mission_id).sort()).toEqual([M1, M2].sort());
    expect(index.activeMissionIds).toEqual([M1]);
    expect(index.activeMissionIdsByTrack.get(TRACK_ID)).toEqual([M1]);
    expect(
      deriveProjectMissionIndex(PROJECT_ID, { tier: 'confidential', tenant: 'acme' }).linked
    ).toEqual([]);
  });

  it('project view lists archived missions and project/mission artifacts', () => {
    // Snapshot/restore the shared ownership registry (artifact-registry.test pattern).
    const registryPath = artifactOwnershipRegistryPath();
    const original = safeExistsSync(registryPath)
      ? (safeReadFile(registryPath, { encoding: 'utf8' }) as string)
      : null;
    try {
      assertProjectViewArtifacts();
    } finally {
      if (original === null) safeRmSync(registryPath, { force: true });
      else safeWriteFile(registryPath, original);
    }
  });
});

function assertProjectViewArtifacts(): void {
  writeAt(pathResolver.missionDir(M2, 'public'), mission(M2, 'active'));
  writeAt(pathResolver.archivedMissionDir(M1), mission(M1, 'archived'));
  const artifactId = `ART-LINK-IDX-${suffix}`;
  appendArtifactOwnershipRecord({
    artifact_id: artifactId,
    mission_id: M1,
    kind: 'report',
    storage_class: 'artifact_store',
    path: 'active/shared/artifacts/system/report/x.md',
    created_at: new Date().toISOString(),
    evidence_refs: [],
  });

  const view = getProjectManagementView(PROJECT_ID);
  expect(view.missions.map((entry) => entry.mission_id)).toEqual([M2]);
  expect(view.archived_missions.map((entry) => entry.mission_id)).toEqual([M1]);
  expect(view.artifacts.map((record) => record.artifact_id)).toContain(artifactId);
}
