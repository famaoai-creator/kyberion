import * as path from 'node:path';
import { listMissionsInSearchDirs, loadStateAtPath } from '../mission/mission-state.js';
import type { MissionState } from '../mission/mission-types.js';
import { pathResolver } from '../path-resolver.js';
import {
  listArtifactOwnershipRecords,
  type ArtifactOwnershipRecord,
} from '../workforce/artifact-registry.js';

/**
 * Project ↔ mission membership, derived from the single source of truth:
 * each mission's `relationships.project` / `relationships.track`. Project
 * operational state, track state and the project record's active lists are
 * projections of this index, never independently accumulated.
 */

/** Mission statuses that keep a mission in a project's active lists. */
export const ACTIVE_PROJECT_MISSION_STATUSES: ReadonlySet<string> = new Set([
  'planned',
  'active',
  'validating',
  'distilling',
  'paused',
]);

/** Tier + tenant partition of a project (`shared` = untenanted). */
export interface ProjectScope {
  tier: 'personal' | 'confidential' | 'public';
  tenant: string;
}

export function projectScopeOf(input: { tier: ProjectScope['tier']; tenant_slug?: string }) {
  return { tier: input.tier, tenant: input.tenant_slug?.trim() || 'shared' } as ProjectScope;
}

export function isMissionInScope(mission: MissionState, scope: ProjectScope): boolean {
  const tenant =
    mission.tenant_slug || mission.tenant_id || (mission.tier === 'confidential' ? '' : 'shared');
  return mission.tier === scope.tier && tenant === scope.tenant;
}

export interface ProjectMissionIndex {
  /** Linked missions in the active mission roots, within the project scope. */
  linked: MissionState[];
  activeMissionIds: string[];
  activeTrackIds: string[];
  /** track_id → active mission ids on that track. */
  activeMissionIdsByTrack: Map<string, string[]>;
}

export function deriveProjectMissionIndex(
  projectId: string,
  scope: ProjectScope,
  rootDir = pathResolver.rootDir()
): ProjectMissionIndex {
  const linked = scanLinkedMissions(projectId, scope, rootDir);
  const active = linked.filter((mission) => ACTIVE_PROJECT_MISSION_STATUSES.has(mission.status));
  const activeMissionIdsByTrack = new Map<string, string[]>();
  for (const mission of active) {
    const trackId = mission.relationships?.track?.track_id?.trim();
    if (!trackId) continue;
    activeMissionIdsByTrack.set(trackId, [
      ...(activeMissionIdsByTrack.get(trackId) || []),
      mission.mission_id,
    ]);
  }
  for (const [trackId, ids] of activeMissionIdsByTrack) {
    activeMissionIdsByTrack.set(trackId, [...new Set(ids)].sort());
  }
  return {
    linked,
    activeMissionIds: [...new Set(active.map((mission) => mission.mission_id))].sort(),
    activeTrackIds: [...activeMissionIdsByTrack.keys()].sort(),
    activeMissionIdsByTrack,
  };
}

/**
 * Linked missions in the scope's active mission root. Deliberately not
 * `projectMissions()`: that view narrows to the caller's own mission under a
 * worker persona, while this index is the system-wide projection the mission
 * controller maintains for every linked mission.
 */
function scanLinkedMissions(
  projectId: string,
  scope: ProjectScope,
  rootDir: string
): MissionState[] {
  const missionRoot =
    scope.tier === 'personal'
      ? path.join(rootDir, 'knowledge/personal/missions')
      : path.join(rootDir, 'active/missions', scope.tier);
  return listMissionsInSearchDirs({ rootDir, directories: [missionRoot] })
    .map(({ missionPath }) => loadStateAtPath(path.join(missionPath, 'mission-state.json')))
    .filter((state): state is MissionState => Boolean(state))
    .filter(
      (state) =>
        state.relationships?.project?.project_id === projectId && isMissionInScope(state, scope)
    );
}

/** Finished missions of a project, read from the mission archive. */
export function projectArchivedMissions(
  projectId: string,
  scope: ProjectScope,
  rootDir = pathResolver.rootDir()
): MissionState[] {
  const archiveRoot =
    rootDir === pathResolver.rootDir()
      ? pathResolver.archivedMissionsRoot()
      : path.join(rootDir, 'active/archive/missions');
  return listMissionsInSearchDirs({ rootDir, directories: [archiveRoot] })
    .map(({ missionPath }) => loadStateAtPath(path.join(missionPath, 'mission-state.json')))
    .filter((state): state is MissionState => Boolean(state))
    .filter(
      (state) =>
        state.relationships?.project?.project_id === projectId && isMissionInScope(state, scope)
    )
    .sort((a, b) => a.mission_id.localeCompare(b.mission_id));
}

/**
 * Artifact ownership records that belong to a project: recorded with its
 * project_id, or owned by one of its missions. Records carrying another
 * tenant or tier are excluded (fail closed on scope mismatch).
 */
export function projectArtifactRecords(
  projectId: string,
  scope: ProjectScope,
  missionIds: Iterable<string>
): ArtifactOwnershipRecord[] {
  const missions = new Set(missionIds);
  // The ownership registry is append-only: a re-registered artifact (e.g. a
  // mission deliverable promoted to its project) appears once per write, and
  // the last row is the current one.
  const latest = new Map<string, ArtifactOwnershipRecord>();
  for (const record of listArtifactOwnershipRecords()) latest.set(record.artifact_id, record);
  return [...latest.values()].filter((record) => {
    if (record.storage_class === 'tmp') return false;
    if (record.tenant_slug && record.tenant_slug !== scope.tenant) return false;
    // Exclude a record carrying another tier (higher-tier data must never
    // surface in a lower-tier project view). Where the file lives is the
    // ground truth; older records may carry a defaulted metadata tier.
    const recordTier = recordTierOf(record);
    if (recordTier && recordTier !== scope.tier) return false;
    if (record.project_id) return record.project_id === projectId;
    return Boolean(record.mission_id && missions.has(record.mission_id));
  });
}

const TIERED_PATH =
  /^(?:active\/(?:missions|projects|organizations|shared\/(?:artifacts|tmp|staging|cache))\/)(personal|confidential|public)\//u;

/** Tier of a record: from its tiered path when it has one, else metadata.tier. */
function recordTierOf(record: ArtifactOwnershipRecord): string | undefined {
  const fromPath = record.path?.replace(/\\/gu, '/').match(TIERED_PATH)?.[1];
  if (fromPath) return fromPath;
  if (record.path?.startsWith('knowledge/personal/')) return 'personal';
  const fromMetadata = (record.metadata as { tier?: unknown } | undefined)?.tier;
  return typeof fromMetadata === 'string' ? fromMetadata : undefined;
}
