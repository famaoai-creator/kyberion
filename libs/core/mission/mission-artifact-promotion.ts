/**
 * Mission → project deliverable promotion at mission finish.
 *
 * A mission linked to a project (`relationships.project`) hands its published
 * deliverables to the project when it finishes: each `report` / `export`
 * scoped artifact that has an ArtifactRecord is COPIED into the project scope
 * (`<projectDir>/artifacts/<class>/missions/<MISSION_ID>/<name>`) and the
 * record is re-pointed at the copy, so the deliverable outlives the mission's
 * archive move in a place the project's surfaces list. The original stays in
 * the mission tree and is archived with it (the archive remains the record of
 * what the mission produced).
 *
 * Placement follows the PROJECT record (tier + tenant), and only a mission
 * inside that scope may promote; the source must be a regular file inside the
 * mission's own `artifacts/` tree.
 *
 * Contract: idempotent and never throws — a promotion failure must never fail
 * a finish that already succeeded. A record already re-pointed no longer
 * matches the mission path, so a re-run promotes nothing twice.
 */
import * as path from 'node:path';
import { parseSafeJsonInput } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import { readTextFile } from '../foundation/text.js';
import { logger } from '../core.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReadFile } from '../secure-io.js';
import type { RetentionArtifactClass } from '../storage-retention-catalog.js';
import {
  ensureRegularScopedArtifactIndex,
  parseScopedArtifactIndexEntry,
  SCOPED_ARTIFACT_INDEX_FILENAME,
  scopedArtifactIndexCatalog,
  scopedTaskArtifactDirName,
  writeScopedArtifact,
  type ScopedArtifactIndexEntry,
} from '../workforce/artifact-store.js';
import { listArtifactRecords, saveArtifactRecord } from '../workforce/artifact-record.js';
import type { MissionState } from './mission-types.js';
import { loadProjectRecord } from '../project/project-registry.js';
import { isMissionInScope, projectScopeOf } from '../project/project-mission-index.js';

/** Deliverable classes handed to the project. Evidence stays with the mission. */
export const MISSION_PROMOTION_CLASSES: readonly RetentionArtifactClass[] = Object.freeze([
  'report',
  'export',
]);

export interface PromotedMissionArtifact {
  artifact_id: string;
  from: string;
  to: string;
}

export interface MissionArtifactPromotionResult {
  status: 'promoted' | 'nothing_to_promote' | 'skipped' | 'partial';
  project_id?: string;
  reason?: string;
  promoted: PromotedMissionArtifact[];
  failed: { path: string; error: string }[];
}

function readMissionIndex(missionDir: string): ScopedArtifactIndexEntry[] {
  const indexPath = assertSafeRepositoryPath(
    path.join(missionDir, 'artifacts', SCOPED_ARTIFACT_INDEX_FILENAME),
    { allowMissingLeaf: true }
  );
  if (!safeExistsSync(indexPath)) return [];
  ensureRegularScopedArtifactIndex(indexPath);
  const catalog = scopedArtifactIndexCatalog(indexPath);
  const entries: ScopedArtifactIndexEntry[] = [];
  readTextFile(indexPath)
    .split('\n')
    .forEach((raw, index) => {
      if (!raw.trim()) return;
      try {
        entries.push(
          parseScopedArtifactIndexEntry(
            catalog.validate(
              parseSafeJsonInput(raw, 'scoped artifact index entry'),
              `${indexPath}:${index + 1}`
            )
          )
        );
      } catch {
        // A malformed row is not a deliverable; closure owns index hygiene.
      }
    });
  return entries;
}

/** Project-relative artifact name: `missions/<ID>/[task-<task>/]<name>`. */
function promotedName(missionId: string, entry: ScopedArtifactIndexEntry): string {
  const taskSegment =
    entry.scope_kind === 'task' && entry.scope.task
      ? `${scopedTaskArtifactDirName(entry.scope.task)}/`
      : '';
  return `missions/${missionId}/${taskSegment}${entry.name}`;
}

/**
 * Resolve a mission index row to its file, confined to the mission's own
 * `artifacts/` tree: the index is writable by mission workers, so a row naming
 * another scope's file (another tier or tenant) must never be copied.
 */
function confinedSource(missionDir: string, entryPath: string): string {
  const source = pathResolver.rootResolve(entryPath);
  const relative = path.relative(path.join(missionDir, 'artifacts'), source);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`deliverable is outside the mission artifacts tree: ${entryPath}`);
  }
  const safe = assertSafeRepositoryPath(source);
  const stats = safeLstat(safe);
  // A hard link would let a file of another scope pass as a mission file.
  if (!stats.isFile() || stats.nlink > 1) {
    throw new Error(`deliverable is not a regular, unlinked file: ${entryPath}`);
  }
  return safe;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function promoteMissionArtifactsToProject(input: {
  missionId: string;
  missionDir: string;
  state: MissionState;
}): MissionArtifactPromotionResult {
  const result: MissionArtifactPromotionResult = {
    status: 'skipped',
    promoted: [],
    failed: [],
  };
  try {
    return promote(input, result);
  } catch (error) {
    // Never fail a finish that already succeeded.
    result.status = result.promoted.length > 0 ? 'partial' : 'skipped';
    result.reason = 'error';
    result.failed.push({
      path: path.join('artifacts', SCOPED_ARTIFACT_INDEX_FILENAME),
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
}

function promote(
  input: { missionId: string; missionDir: string; state: MissionState },
  result: MissionArtifactPromotionResult
): MissionArtifactPromotionResult {
  const missionId = stringOrEmpty(input.missionId).toUpperCase();
  const projectId = stringOrEmpty(input.state.relationships?.project?.project_id);
  if (!missionId || !projectId) return { ...result, reason: 'no_project' };
  result.project_id = projectId;
  // Placement comes from the project record (the owner), never from the
  // mission: a deliverable promoted into a project lives in the project's
  // tier and tenant, and only a mission inside that scope may promote.
  const project = loadProjectRecord(projectId);
  if (!project) return { ...result, reason: 'project_not_found' };
  const scope = projectScopeOf(project);
  if (!isMissionInScope(input.state, scope)) {
    logger.warn(
      `mission artifact promotion skipped — mission ${missionId} is outside project ${projectId}'s scope (${scope.tier}/${scope.tenant}) | deliverables stay in the mission archive | relink the mission to a project in its own tier/tenant`
    );
    return { ...result, reason: 'scope_mismatch' };
  }
  const tenant = scope.tenant === 'shared' ? undefined : scope.tenant;
  result.status = 'nothing_to_promote';

  const deliverables = readMissionIndex(input.missionDir).filter(
    (entry) =>
      MISSION_PROMOTION_CLASSES.includes(entry.artifact_class) &&
      (entry.scope_kind === 'mission' || entry.scope_kind === 'task')
  );
  if (deliverables.length === 0) return result;
  // The index is append-only: the last row for a path is the current write.
  const byPath = new Map(deliverables.map((entry) => [entry.path, entry]));
  // Several records may share one path (re-published): copy once, re-point all.
  const recordsByPath = new Map<string, ReturnType<typeof listArtifactRecords>>();
  for (const record of listArtifactRecords()) {
    if (record.mission_id?.toUpperCase() !== missionId || !record.path) continue;
    if (!byPath.has(record.path)) continue;
    recordsByPath.set(record.path, [...(recordsByPath.get(record.path) || []), record]);
  }
  const archiveDir = pathResolver.toRepoRelative(pathResolver.archivedMissionDir(missionId));
  for (const [entryPath, records] of recordsByPath) {
    const entry = byPath.get(entryPath) as ScopedArtifactIndexEntry;
    try {
      const source = confinedSource(input.missionDir, entryPath);
      const content = safeReadFile(source, { encoding: null }) as Buffer;
      const written = writeScopedArtifact({
        scope: { project: projectId, ...(tenant ? { tenant } : {}) },
        tier: scope.tier,
        artifact_class: entry.artifact_class,
        name: promotedName(missionId, entry),
        content,
        format: 'buffer',
      });
      // The mission tree moves to the archive right after promotion.
      const archivedFrom = path.posix.join(
        archiveDir.split(path.sep).join('/'),
        path.relative(input.missionDir, source).split(path.sep).join('/')
      );
      const promotedAt = nowIso();
      for (const record of records) {
        // A shared project carries no tenant: drop any tenant the mission
        // publish recorded, so the record matches its new scope.
        const { tenant_slug: _previousTenant, ...rest } = record;
        saveArtifactRecord({
          ...rest,
          path: written.repo_relative_path,
          project_id: projectId,
          ...(tenant ? { tenant_slug: tenant } : {}),
          metadata: {
            ...(record.metadata || {}),
            tier: scope.tier,
            scope_kind: 'project',
            promoted_from: archivedFrom,
            promoted_from_mission: missionId,
            promoted_at: promotedAt,
          },
        });
        result.promoted.push({
          artifact_id: record.artifact_id,
          from: entryPath,
          to: written.repo_relative_path,
        });
      }
    } catch (error) {
      result.failed.push({
        path: entryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (result.failed.length > 0) {
    logger.warn(
      `mission artifact promotion incomplete — ${result.failed.length} deliverable(s) not copied to project ${projectId} | originals stay in the mission archive | mission=${missionId}`
    );
    result.status = result.promoted.length > 0 ? 'partial' : 'skipped';
    result.reason = 'copy_failed';
  } else if (result.promoted.length > 0) {
    result.status = 'promoted';
  }
  return result;
}
