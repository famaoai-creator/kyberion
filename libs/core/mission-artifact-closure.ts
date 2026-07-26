/**
 * AL-03: mission finish / task completion artifact closure.
 *
 * Connects the retention vocabulary (AL-01, `storage-retention-catalog.ts`)
 * and the scope-local artifact index (AL-02, `artifact-store.ts`) to the
 * mission lifecycle events that should reclaim storage:
 *
 *  - `closeMissionArtifacts` runs at mission finish (after every finish gate
 *    passed and the state transitioned to `completed`): deletes the
 *    disposable artifact classes (`cache`, `tmp`) from the mission tree,
 *    bundles the per-mission git repo into `evidence/mission-repo.bundle`
 *    and removes the nested `.git` directory (the KM-04 nested-git hazard),
 *    and leaves an audit record of what was deleted and why.
 *  - `closeTaskArtifacts` runs when a task contract's completion is
 *    finalized: deletes that task's `cache`/`tmp` scoped artifacts
 *    (`<missionDir>/artifacts/<class>/task-<taskId>/`) while leaving
 *    `evidence`/`report`/`export` classes untouched.
 *
 * Contract: both entry points are IDEMPOTENT and NEVER THROW — a closure
 * failure must never fail the finish/dispatch that already succeeded, and
 * a bundle failure keeps the `.git` directory (never lose data). Deletions
 * are audited to `active/shared/logs/audit/mission-closure.jsonl` (sibling
 * of AL-01's `mission-purge.jsonl`).
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { logger } from './core.js';
import {
  safeAppendFileSync,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import {
  RETENTION_CATALOG_REPO_PATH,
  type RetentionArtifactClass,
} from './storage-retention-catalog.js';
import {
  SCOPED_ARTIFACT_INDEX_FILENAME,
  scopedTaskArtifactDirName,
  type ScopedArtifactIndexEntry,
} from './artifact-store.js';

/** Artifact classes deleted at closure time. Everything else is kept. */
export const MISSION_CLOSURE_DELETE_CLASSES: readonly RetentionArtifactClass[] = Object.freeze([
  'cache',
  'tmp',
]) as readonly RetentionArtifactClass[];

/** Audit log (JSONL) for closure deletions — sibling of mission-purge.jsonl. */
export const MISSION_CLOSURE_AUDIT_FILENAME = 'mission-closure.jsonl';

/** Idempotency marker written into the mission tree once closure completed. */
export const MISSION_CLOSURE_MARKER_RELPATH = 'evidence/mission-closure.json';

/** Where the per-mission git history is preserved before `.git` removal. */
export const MISSION_REPO_BUNDLE_RELPATH = 'evidence/mission-repo.bundle';

export interface MissionClosureBundleOutcome {
  /**
   * - `bundled`: `git bundle create --all` succeeded and `.git` was removed.
   * - `already_bundled`: no `.git` but the bundle exists (previous closure).
   * - `no_git`: the mission tree has no `.git` directory (nothing to do).
   * - `failed`: bundling failed — `.git` is KEPT (never lose data).
   */
  status: 'bundled' | 'already_bundled' | 'no_git' | 'failed';
  /** Mission-relative bundle path when a bundle exists. */
  bundle_path?: string;
  error?: string;
}

export interface MissionClosureDeletedIndexEntry {
  path: string;
  artifact_class: RetentionArtifactClass;
}

export interface CloseMissionArtifactsResult {
  status: 'closed' | 'already_closed' | 'mission_not_found' | 'error';
  mission_id: string;
  mission_dir?: string;
  /** Repo-relative directories removed (artifacts/cache, artifacts/tmp, …). */
  deleted_directories: string[];
  /** artifacts-index.jsonl entries dropped because their class is disposable. */
  deleted_index_entries: MissionClosureDeletedIndexEntry[];
  kept_index_entries: number;
  bundle?: MissionClosureBundleOutcome;
  audit_path?: string;
  marker_path?: string;
  error?: string;
}

export interface CloseTaskArtifactsResult {
  status: 'closed' | 'noop' | 'mission_not_found' | 'error';
  mission_id: string;
  task_id: string;
  deleted_directories: string[];
  deleted_index_entries: MissionClosureDeletedIndexEntry[];
  audit_path?: string;
  error?: string;
}

interface IndexLine {
  raw: string;
  parsed: ScopedArtifactIndexEntry | null;
}

function toRepoRelativePosix(absolutePath: string): string {
  return pathResolver.toRepoRelative(absolutePath).split(path.sep).join('/');
}

function readIndexLines(indexPath: string): IndexLine[] {
  if (!safeExistsSync(indexPath)) return [];
  return String(safeReadFile(indexPath, { encoding: 'utf8' }))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((raw) => {
      try {
        const parsed = JSON.parse(raw) as ScopedArtifactIndexEntry;
        return { raw, parsed: parsed && typeof parsed === 'object' ? parsed : null };
      } catch {
        // Corrupt lines are preserved verbatim on rewrite — closure reclaims
        // storage, it never silently drops records it cannot understand.
        return { raw, parsed: null };
      }
    });
}

function writeIndexLines(indexPath: string, lines: IndexLine[]): void {
  safeWriteFile(indexPath, lines.map((line) => line.raw).join('\n') + (lines.length ? '\n' : ''));
}

function isDisposableClass(value: unknown): value is RetentionArtifactClass {
  return MISSION_CLOSURE_DELETE_CLASSES.includes(value as RetentionArtifactClass);
}

/**
 * Delete an index entry's file when it still exists AND resolves inside the
 * mission tree (fail-safe: closure never deletes outside the mission dir).
 */
function deleteIndexEntryFile(missionDir: string, entry: ScopedArtifactIndexEntry): void {
  const resolved = pathResolver.rootResolve(entry.path);
  if (!resolved.startsWith(missionDir + path.sep)) return;
  if (safeExistsSync(resolved)) safeRmSync(resolved, { recursive: true, force: true });
}

function appendClosureAudit(record: Record<string, unknown>): string | undefined {
  try {
    const auditPath = pathResolver.sharedLogsAudit(MISSION_CLOSURE_AUDIT_FILENAME);
    safeAppendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    return auditPath;
  } catch (err) {
    logger.warn(
      `[mission-artifact-closure] failed to append audit record: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/**
 * Preserve the per-mission git history as `evidence/mission-repo.bundle` and
 * remove the nested `.git` directory (KM-04 nested-git hazard). Bundle
 * failure keeps `.git` — the history is never lost to a failed bundle.
 */
function bundleMissionGitRepo(missionDir: string): MissionClosureBundleOutcome {
  const gitDir = path.join(missionDir, '.git');
  const bundleAbs = path.join(missionDir, ...MISSION_REPO_BUNDLE_RELPATH.split('/'));
  if (!safeExistsSync(gitDir)) {
    return safeExistsSync(bundleAbs)
      ? { status: 'already_bundled', bundle_path: MISSION_REPO_BUNDLE_RELPATH }
      : { status: 'no_git' };
  }
  try {
    const evidenceDir = path.dirname(bundleAbs);
    if (!safeExistsSync(evidenceDir)) safeMkdir(evidenceDir, { recursive: true });
    safeExec('git', ['bundle', 'create', bundleAbs, '--all'], { cwd: missionDir });
    if (!safeExistsSync(bundleAbs)) {
      throw new Error('git bundle reported success but the bundle file does not exist');
    }
    safeRmSync(gitDir, { recursive: true, force: true });
    return { status: 'bundled', bundle_path: MISSION_REPO_BUNDLE_RELPATH };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[mission-artifact-closure] git bundle failed for ${missionDir} — keeping .git (never lose data): ${message}`
    );
    return { status: 'failed', error: message };
  }
}

/**
 * Mission-finish retention closure. Idempotent (a marker in the mission tree
 * makes a second call a structured no-op) and never throws. Callers MUST
 * invoke it only after every finish gate passed — the caller's placement,
 * not this function, is what guarantees failed finishes leave the tree
 * untouched.
 */
export function closeMissionArtifacts(input: {
  missionId: string;
  /** Resolved mission directory; looked up via findMissionPath when omitted. */
  missionDir?: string;
}): CloseMissionArtifactsResult {
  const missionId = String(input.missionId || '').toUpperCase();
  const base: CloseMissionArtifactsResult = {
    status: 'error',
    mission_id: missionId,
    deleted_directories: [],
    deleted_index_entries: [],
    kept_index_entries: 0,
  };
  try {
    const missionDir = input.missionDir ?? findMissionPath(missionId);
    if (!missionDir || !safeExistsSync(missionDir)) {
      return { ...base, status: 'mission_not_found' };
    }
    const markerPath = path.join(missionDir, ...MISSION_CLOSURE_MARKER_RELPATH.split('/'));
    if (safeExistsSync(markerPath)) {
      return {
        ...base,
        status: 'already_closed',
        mission_dir: missionDir,
        marker_path: markerPath,
      };
    }

    const artifactsRoot = path.join(missionDir, 'artifacts');
    const indexPath = path.join(artifactsRoot, SCOPED_ARTIFACT_INDEX_FILENAME);
    const indexLines = readIndexLines(indexPath);
    const keptLines: IndexLine[] = [];
    const deletedIndexEntries: MissionClosureDeletedIndexEntry[] = [];
    for (const line of indexLines) {
      if (line.parsed && isDisposableClass(line.parsed.artifact_class)) {
        deletedIndexEntries.push({
          path: line.parsed.path,
          artifact_class: line.parsed.artifact_class,
        });
        deleteIndexEntryFile(missionDir, line.parsed);
      } else {
        keptLines.push(line);
      }
    }

    const deletedDirectories: string[] = [];
    for (const artifactClass of MISSION_CLOSURE_DELETE_CLASSES) {
      const classDir = path.join(artifactsRoot, artifactClass);
      if (safeExistsSync(classDir)) {
        safeRmSync(classDir, { recursive: true, force: true });
        deletedDirectories.push(toRepoRelativePosix(classDir));
      }
    }
    if (deletedIndexEntries.length > 0) {
      writeIndexLines(indexPath, keptLines);
    }

    const bundle = bundleMissionGitRepo(missionDir);

    const auditPath = appendClosureAudit({
      ts: new Date().toISOString(),
      event: 'MISSION_ARTIFACTS_CLOSED',
      mission: missionId,
      mission_dir: toRepoRelativePosix(missionDir),
      deleted_directories: deletedDirectories,
      deleted_index_entries: deletedIndexEntries,
      kept_index_entries: keptLines.length,
      bundle,
      policy_ref: RETENTION_CATALOG_REPO_PATH,
      policy_classes: [...MISSION_CLOSURE_DELETE_CLASSES],
      reason:
        'mission finish retention closure (AL-03): disposable classes deleted, evidence/report/export kept',
    });

    const markerDir = path.dirname(markerPath);
    if (!safeExistsSync(markerDir)) safeMkdir(markerDir, { recursive: true });
    safeWriteFile(
      markerPath,
      JSON.stringify(
        {
          mission_id: missionId,
          closed_at: new Date().toISOString(),
          deleted_directories: deletedDirectories,
          deleted_index_entry_count: deletedIndexEntries.length,
          bundle,
          policy_ref: RETENTION_CATALOG_REPO_PATH,
        },
        null,
        2
      )
    );

    return {
      status: 'closed',
      mission_id: missionId,
      mission_dir: missionDir,
      deleted_directories: deletedDirectories,
      deleted_index_entries: deletedIndexEntries,
      kept_index_entries: keptLines.length,
      bundle,
      audit_path: auditPath,
      marker_path: markerPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[mission-artifact-closure] closure failed for ${missionId}: ${message}`);
    return { ...base, status: 'error', error: message };
  }
}

/**
 * Task-completion GC: reclaim the completed task's disposable scoped
 * artifacts (`<missionDir>/artifacts/<cache|tmp>/task-<taskId>/` plus their
 * artifacts-index.jsonl entries). Evidence/report/export classes — including
 * the same task's — are untouched. Idempotent: a second call (or a task with
 * no disposable artifacts) returns a structured `noop` without an audit
 * record. Never throws.
 */
export function closeTaskArtifacts(
  missionId: string,
  taskId: string,
  options: { missionDir?: string } = {}
): CloseTaskArtifactsResult {
  const upperMission = String(missionId || '').toUpperCase();
  const base: CloseTaskArtifactsResult = {
    status: 'error',
    mission_id: upperMission,
    task_id: taskId,
    deleted_directories: [],
    deleted_index_entries: [],
  };
  try {
    const missionDir = options.missionDir ?? findMissionPath(upperMission);
    if (!missionDir || !safeExistsSync(missionDir)) {
      return { ...base, status: 'mission_not_found' };
    }
    const taskDirName = scopedTaskArtifactDirName(taskId);
    const artifactsRoot = path.join(missionDir, 'artifacts');

    const deletedDirectories: string[] = [];
    for (const artifactClass of MISSION_CLOSURE_DELETE_CLASSES) {
      const taskDir = path.join(artifactsRoot, artifactClass, taskDirName);
      if (safeExistsSync(taskDir)) {
        safeRmSync(taskDir, { recursive: true, force: true });
        deletedDirectories.push(toRepoRelativePosix(taskDir));
      }
    }

    const indexPath = path.join(artifactsRoot, SCOPED_ARTIFACT_INDEX_FILENAME);
    const indexLines = readIndexLines(indexPath);
    const keptLines: IndexLine[] = [];
    const deletedIndexEntries: MissionClosureDeletedIndexEntry[] = [];
    for (const line of indexLines) {
      const entry = line.parsed;
      const entryTask = entry?.scope?.task;
      const matchesTask =
        entryTask !== undefined &&
        (String(entryTask) === String(taskId) ||
          scopedTaskArtifactDirName(String(entryTask)) === taskDirName);
      if (entry && matchesTask && isDisposableClass(entry.artifact_class)) {
        deletedIndexEntries.push({ path: entry.path, artifact_class: entry.artifact_class });
        deleteIndexEntryFile(missionDir, entry);
      } else {
        keptLines.push(line);
      }
    }
    if (deletedIndexEntries.length > 0) {
      writeIndexLines(indexPath, keptLines);
    }

    if (deletedDirectories.length === 0 && deletedIndexEntries.length === 0) {
      return { ...base, status: 'noop' };
    }

    const auditPath = appendClosureAudit({
      ts: new Date().toISOString(),
      event: 'MISSION_TASK_ARTIFACTS_CLOSED',
      mission: upperMission,
      task: taskId,
      deleted_directories: deletedDirectories,
      deleted_index_entries: deletedIndexEntries,
      policy_ref: RETENTION_CATALOG_REPO_PATH,
      policy_classes: [...MISSION_CLOSURE_DELETE_CLASSES],
      reason:
        'task completion GC (AL-03): disposable task-scoped classes deleted, evidence untouched',
    });

    return {
      status: 'closed',
      mission_id: upperMission,
      task_id: taskId,
      deleted_directories: deletedDirectories,
      deleted_index_entries: deletedIndexEntries,
      audit_path: auditPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[mission-artifact-closure] task GC failed for ${upperMission}/${taskId}: ${message}`
    );
    return { ...base, status: 'error', error: message };
  }
}
