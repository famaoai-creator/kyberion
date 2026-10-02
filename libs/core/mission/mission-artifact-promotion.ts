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
import { assertSafeRepositoryPath, safeExistsSync, safeReadFile } from '../secure-io.js';
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

export function promoteMissionArtifactsToProject(input: {
  missionId: string;
  missionDir: string;
  state: MissionState;
}): MissionArtifactPromotionResult {
  const missionId = input.missionId.toUpperCase();
  const projectId = input.state.relationships?.project?.project_id?.trim();
  if (!projectId) {
    return { status: 'skipped', reason: 'no_project', promoted: [], failed: [] };
  }
  const tier = input.state.tier;
  const tenant = (input.state.tenant_slug || input.state.tenant_id || '').trim() || undefined;
  const result: MissionArtifactPromotionResult = {
    status: 'nothing_to_promote',
    project_id: projectId,
    promoted: [],
    failed: [],
  };
  try {
    const deliverables = readMissionIndex(input.missionDir).filter(
      (entry) =>
        MISSION_PROMOTION_CLASSES.includes(entry.artifact_class) &&
        (entry.scope_kind === 'mission' || entry.scope_kind === 'task')
    );
    if (deliverables.length === 0) return result;
    const records = listArtifactRecords().filter(
      (record) => record.mission_id?.toUpperCase() === missionId && record.path
    );
    // The index is append-only: the last row for a path is the current write.
    const byPath = new Map(deliverables.map((entry) => [entry.path, entry]));
    for (const record of records) {
      const entry = byPath.get(record.path as string);
      if (!entry) continue;
      try {
        const source = pathResolver.rootResolve(entry.path);
        const content = safeReadFile(source, { encoding: null }) as Buffer;
        const written = writeScopedArtifact({
          scope: { project: projectId, ...(tenant ? { tenant } : {}) },
          tier,
          artifact_class: entry.artifact_class,
          name: promotedName(missionId, entry),
          content,
          format: 'buffer',
        });
        saveArtifactRecord({
          ...record,
          path: written.repo_relative_path,
          project_id: projectId,
          metadata: {
            ...(record.metadata || {}),
            promoted_from: entry.path,
            promoted_at: nowIso(),
          },
        });
        result.promoted.push({
          artifact_id: record.artifact_id,
          from: entry.path,
          to: written.repo_relative_path,
        });
      } catch (error) {
        result.failed.push({
          path: entry.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    result.failed.push({
      path: path.join('artifacts', SCOPED_ARTIFACT_INDEX_FILENAME),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (result.failed.length > 0) {
    logger.warn(
      `mission artifact promotion incomplete — ${result.failed.length} deliverable(s) not copied to project ${projectId} | originals stay in the mission archive | mission=${missionId}`
    );
    result.status = result.promoted.length > 0 ? 'partial' : 'skipped';
    if (!result.reason) result.reason = 'copy_failed';
  } else if (result.promoted.length > 0) {
    result.status = 'promoted';
  }
  return result;
}
