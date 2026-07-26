/**
 * AL-04: scope-linked GC and scope offboarding.
 *
 * AL-01..03 connected retention to TTLs (catalog-driven janitor) and to the
 * mission's own tree (finish/archive closure). What was still missing is the
 * residue a mission leaves OUTSIDE its tree, and any verb at all for the two
 * scopes above a mission:
 *
 *  - {@link gcMissionRuntimeResidue} — run at mission archive: reclaims the
 *    `active/shared/runtime/` entries that belong to one mission (artifact
 *    records, task sessions, that mission's volatile session directories).
 *    The mission tree itself is already handled by AL-03's closure ceremony.
 *  - {@link offboardScope} — the tenant/project offboarding verb: discover →
 *    export → delete, with a MANDATORY human approval for the delete step
 *    (same `approved_by` + `purpose` evidence shape tier-guard requires of
 *    `cross_tenant_brokerage`), every step audited.
 *
 * Deletion discipline: everything here deletes through AL-04's soft-delete
 * (`softDeleteToTrash` → `active/archive/.trash/<original-path>`), so an
 * offboarding or residue GC is recoverable with `restoreFromTrash` until the
 * janitor's trash sweep purges it. Nothing in this module hard-deletes.
 *
 * Contract: both entry points are IDEMPOTENT (a second run finds nothing
 * left and reports a no-op) and NEVER THROW — they are lifecycle hooks, and
 * a GC failure must never fail the archive/offboard decision that already
 * succeeded. Failures surface as `status: 'error'` plus an audit record.
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { logger } from './core.js';
import {
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import {
  appendRetentionAudit,
  repoRelativePosix,
  softDeleteToTrash,
  TRASH_REPO_SUBPATH,
} from './storage-janitor.js';
import { RETENTION_CATALOG_REPO_PATH } from './storage-retention-catalog.js';

// ---------------------------------------------------------------------------
// Mission runtime residue
// ---------------------------------------------------------------------------

/**
 * Where a mission's residue can live outside its own tree. Deliberately a
 * CLOSED list of probes with an explicit match rule each — a heuristic sweep
 * over `runtime/` would risk deleting another scope's state, so anything not
 * listed here is left alone (and stays visible through the janitor's
 * uncovered/review_required reporting).
 *
 * Not probed, on purpose: `runtime/work-coordination/` (work items are
 * project-scoped and shared across missions), `runtime/audit/` and
 * `runtime/state/` (audit + load-bearing state, `review_required` in the
 * catalog).
 */
export type MissionResidueProbe = 'runtime_artifacts' | 'task_sessions' | 'session_volatile';

export interface MissionResidueCandidate {
  /** Repo-relative POSIX path. */
  path: string;
  probe: MissionResidueProbe;
}

export interface GcMissionRuntimeResidueResult {
  status: 'gc' | 'noop' | 'error';
  mission_id: string;
  dry_run: boolean;
  candidates: MissionResidueCandidate[];
  /** Repo-relative paths moved to the trash this run. */
  soft_deleted: string[];
  error?: string;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' })));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function listDirEntries(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  try {
    return safeReaddir(dir);
  } catch {
    return [];
  }
}

/** Mission ids are compared case-insensitively (`findMissionPath` upper-cases). */
function sameMission(value: unknown, missionId: string): boolean {
  return typeof value === 'string' && value.trim().toUpperCase() === missionId;
}

function collectMissionResidue(missionId: string): MissionResidueCandidate[] {
  const candidates: MissionResidueCandidate[] = [];

  // 1. Artifact records (`runtime/artifacts/<artifact_id>.json`) carry an
  //    optional `mission_id`. The artifact OWNERSHIP ledger is a separate,
  //    append-only record and is never touched here.
  const artifactsDir = pathResolver.shared('runtime/artifacts');
  for (const name of listDirEntries(artifactsDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(artifactsDir, name);
    const record = readJsonRecord(filePath);
    if (record && sameMission(record.mission_id, missionId)) {
      candidates.push({ path: repoRelativePosix(filePath), probe: 'runtime_artifacts' });
    }
  }

  // 2. Task sessions (`runtime/task-sessions/<session_id>.json`) reference the
  //    mission either at the top level or through their `artifact` block.
  const taskSessionsDir = pathResolver.shared('runtime/task-sessions');
  for (const name of listDirEntries(taskSessionsDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(taskSessionsDir, name);
    const record = readJsonRecord(filePath);
    if (!record) continue;
    const artifact = record.artifact as Record<string, unknown> | undefined;
    if (sameMission(record.mission_id, missionId) || sameMission(artifact?.mission_id, missionId)) {
      candidates.push({ path: repoRelativePosix(filePath), probe: 'task_sessions' });
    }
  }

  // 3. Volatile session directories (`runtime/session/<session-id>/`,
  //    path-resolver `volatile('session', ref)`) named after the mission —
  //    either exactly, or `<MISSION-ID>-<suffix>` for per-task sessions.
  const sessionRoot = pathResolver.shared('runtime/session');
  for (const name of listDirEntries(sessionRoot)) {
    const upper = name.toUpperCase();
    if (upper !== missionId && !upper.startsWith(`${missionId}-`)) continue;
    candidates.push({
      path: repoRelativePosix(path.join(sessionRoot, name)),
      probe: 'session_volatile',
    });
  }

  return candidates;
}

/**
 * Reclaim one mission's `active/shared/runtime/` residue. Called from the
 * mission archive verbs (`archiveMissionById`, `purgeMissions`) once the
 * mission tree has been moved to the archive — at that point the runtime
 * entries pointing into it are dangling by construction.
 *
 * Soft-deletes (recoverable) and audits every removal. Idempotent and never
 * throws.
 */
export function gcMissionRuntimeResidue(input: {
  missionId: string;
  dryRun?: boolean;
}): GcMissionRuntimeResidueResult {
  const missionId = String(input.missionId || '')
    .trim()
    .toUpperCase();
  const dryRun = input.dryRun ?? false;
  const result: GcMissionRuntimeResidueResult = {
    status: 'noop',
    mission_id: missionId,
    dry_run: dryRun,
    candidates: [],
    soft_deleted: [],
  };
  if (!missionId) {
    result.status = 'error';
    result.error = 'missionId is required';
    return result;
  }

  try {
    result.candidates = collectMissionResidue(missionId);
    if (result.candidates.length === 0) return result;
    result.status = 'gc';
    if (dryRun) return result;

    for (const candidate of result.candidates) {
      const absolute = pathResolver.rootResolve(candidate.path);
      try {
        if (!safeExistsSync(absolute)) continue;
        softDeleteToTrash(absolute);
        result.soft_deleted.push(candidate.path);
        appendRetentionAudit({
          event: 'MISSION_RESIDUE_SOFT_DELETE',
          path: candidate.path,
          trash_path: `${TRASH_REPO_SUBPATH}/${candidate.path}`,
          mission_id: missionId,
          probe: candidate.probe,
          policy_ref: RETENTION_CATALOG_REPO_PATH,
          reason: 'mission archived — scope-linked runtime residue GC (AL-04)',
        });
      } catch (err) {
        logger.warn(
          `[scope-offboarding] failed to reclaim ${candidate.path} for ${missionId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    return result;
  } catch (err) {
    result.status = 'error';
    result.error = err instanceof Error ? err.message : String(err);
    logger.warn(`[scope-offboarding] mission residue GC failed for ${missionId}: ${result.error}`);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Tenant / project offboarding
// ---------------------------------------------------------------------------

export type OffboardScopeType = 'tenant' | 'project';

/**
 * Human approval for the irreversible half of an offboarding. Same evidence
 * shape tier-guard demands of `cross_tenant_brokerage`: WHO approved and WHY.
 * Without it the verb refuses to delete (fail-closed) — a dry run and the
 * export need no approval, only the removal does.
 */
export interface OffboardApproval {
  approved_by: string;
  purpose: string;
  /** ISO-8601; stamped at execution time when the caller omits it. */
  approved_at?: string;
}

export type OffboardTargetKind = 'project_tree' | 'mission_tree';

export interface OffboardTarget {
  /** Repo-relative POSIX path. */
  path: string;
  kind: OffboardTargetKind;
}

export interface OffboardScopeResult {
  status: 'dry_run' | 'offboarded' | 'approval_required' | 'not_found' | 'error';
  scope_type: OffboardScopeType;
  scope_id: string;
  dry_run: boolean;
  targets: OffboardTarget[];
  /** Repo-relative export directory (execute mode only). */
  export_path?: string;
  /** Repo-relative paths moved to the trash (execute mode only). */
  soft_deleted: string[];
  reason?: string;
}

/** Where offboarding exports land, under the catalog's `active/shared/exports` tree. */
export const OFFBOARDING_EXPORT_SUBDIR = 'offboarding';

const SCOPE_TIERS = ['personal', 'confidential', 'public'] as const;

function missionStateScope(missionDir: string): {
  tenantSlug?: string;
  projectId?: string;
} {
  const record = readJsonRecord(path.join(missionDir, 'mission-state.json'));
  if (!record) return {};
  const relationships = record.relationships as Record<string, unknown> | undefined;
  const project = relationships?.project as Record<string, unknown> | undefined;
  return {
    tenantSlug: typeof record.tenant_slug === 'string' ? record.tenant_slug : undefined,
    projectId: typeof project?.project_id === 'string' ? project.project_id : undefined,
  };
}

/**
 * Everything under `active/` that belongs to the scope: its project workspace
 * tree(s) and every mission declaring it. Deliberately `active/`-only — the
 * `knowledge/` tier system is KM's territory and out of this plan's scope, so
 * an offboarding never touches promoted knowledge.
 */
export function collectScopeTargets(
  scopeType: OffboardScopeType,
  scopeId: string
): OffboardTarget[] {
  const targets: OffboardTarget[] = [];
  const id = scopeId.trim();
  if (!id) return targets;

  // Project workspace trees: `active/projects/<tier>/<id>` — the same
  // location path-resolver's volatile('project'|'tenant', ref) resolves to.
  for (const tier of SCOPE_TIERS) {
    const dir = path.join(pathResolver.rootDir(), 'active', 'projects', tier, id);
    if (safeExistsSync(dir)) {
      targets.push({ path: repoRelativePosix(dir), kind: 'project_tree' });
    }
  }

  // Mission trees declaring the scope in their state.
  const missionsRoot = path.join(pathResolver.rootDir(), 'active', 'missions');
  for (const tier of SCOPE_TIERS) {
    const tierDir = path.join(missionsRoot, tier);
    for (const name of listDirEntries(tierDir)) {
      const missionDir = path.join(tierDir, name);
      try {
        if (!safeStat(missionDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const scope = missionStateScope(missionDir);
      const matches = scopeType === 'tenant' ? scope.tenantSlug === id : scope.projectId === id;
      if (matches) targets.push({ path: repoRelativePosix(missionDir), kind: 'mission_tree' });
    }
  }

  return targets;
}

/** Recursive copy through secure-io (no shell, cross-platform). */
function copyTree(source: string, destination: string): void {
  const stat = safeStat(source);
  if (stat.isDirectory()) {
    if (!safeExistsSync(destination)) safeMkdir(destination, { recursive: true });
    for (const name of listDirEntries(source)) {
      copyTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  const parent = path.dirname(destination);
  if (!safeExistsSync(parent)) safeMkdir(parent, { recursive: true });
  safeCopyFileSync(source, destination);
}

export interface OffboardScopeInput {
  scopeType: OffboardScopeType;
  scopeId: string;
  /** `dry_run` (default) only reports; `execute` exports then deletes. */
  mode?: 'dry_run' | 'execute';
  approval?: OffboardApproval;
  /** Clock override for deterministic export directory names in tests. */
  nowIso?: string;
}

/**
 * Tenant / project offboarding: **discover → export → delete**.
 *
 *  - `mode: 'dry_run'` (default) reports the targets and writes nothing —
 *    always safe to run, never needs approval.
 *  - `mode: 'execute'` requires a human {@link OffboardApproval}; without one
 *    the verb returns `approval_required` and touches nothing (fail-closed).
 *    With one it copies every target into
 *    `active/shared/exports/offboarding/<scope>-<id>-<timestamp>/` (plus a
 *    `manifest.json` recording the approval), then soft-deletes the originals.
 *
 * Idempotent (a second execute finds no targets → `not_found`) and never
 * throws.
 */
export function offboardScope(input: OffboardScopeInput): OffboardScopeResult {
  const scopeType = input.scopeType;
  const scopeId = String(input.scopeId || '').trim();
  const mode = input.mode ?? 'dry_run';
  const result: OffboardScopeResult = {
    status: mode === 'execute' ? 'offboarded' : 'dry_run',
    scope_type: scopeType,
    scope_id: scopeId,
    dry_run: mode !== 'execute',
    targets: [],
    soft_deleted: [],
  };
  if (!scopeId) {
    result.status = 'error';
    result.reason = 'scopeId is required';
    return result;
  }

  try {
    result.targets = collectScopeTargets(scopeType, scopeId);
    if (result.targets.length === 0) {
      result.status = 'not_found';
      result.reason = `no active/ trees found for ${scopeType} '${scopeId}'`;
      return result;
    }

    if (mode !== 'execute') {
      appendRetentionAudit({
        event: 'SCOPE_OFFBOARD_DRY_RUN',
        scope_type: scopeType,
        scope_id: scopeId,
        targets: result.targets.map((target) => target.path),
        policy_ref: RETENTION_CATALOG_REPO_PATH,
        reason: 'offboarding dry run (no writes)',
      });
      return result;
    }

    const approvedBy = input.approval?.approved_by?.trim();
    const purpose = input.approval?.purpose?.trim();
    if (!approvedBy || !purpose) {
      result.status = 'approval_required';
      result.reason =
        'offboarding delete requires a human approval with approved_by and purpose ' +
        '(dry_run needs none) — refusing to delete';
      appendRetentionAudit({
        event: 'SCOPE_OFFBOARD_DENIED',
        scope_type: scopeType,
        scope_id: scopeId,
        targets: result.targets.map((target) => target.path),
        policy_ref: RETENTION_CATALOG_REPO_PATH,
        reason: result.reason,
      });
      return result;
    }

    const nowIso = input.nowIso ?? new Date().toISOString();
    const approvedAt = input.approval?.approved_at ?? nowIso;
    const exportDirName = `${scopeType}-${scopeId}-${nowIso.replace(/[:.]/g, '-')}`;
    const exportDirAbs = pathResolver.sharedExports(
      path.join(OFFBOARDING_EXPORT_SUBDIR, exportDirName)
    );
    if (!safeExistsSync(exportDirAbs)) safeMkdir(exportDirAbs, { recursive: true });
    result.export_path = repoRelativePosix(exportDirAbs);

    // Export first: the deletion below is only reached once every target has
    // a copy under the export directory.
    for (const target of result.targets) {
      copyTree(
        pathResolver.rootResolve(target.path),
        path.join(exportDirAbs, ...target.path.split('/'))
      );
    }
    safeWriteFile(
      path.join(exportDirAbs, 'manifest.json'),
      JSON.stringify(
        {
          scope_type: scopeType,
          scope_id: scopeId,
          exported_at: nowIso,
          approval: { approved_by: approvedBy, approved_at: approvedAt, purpose },
          targets: result.targets,
          policy_ref: RETENTION_CATALOG_REPO_PATH,
        },
        null,
        2
      )
    );
    appendRetentionAudit({
      event: 'SCOPE_OFFBOARD_EXPORTED',
      scope_type: scopeType,
      scope_id: scopeId,
      export_path: result.export_path,
      targets: result.targets.map((target) => target.path),
      approved_by: approvedBy,
      approved_at: approvedAt,
      purpose,
      policy_ref: RETENTION_CATALOG_REPO_PATH,
      reason: 'offboarding export completed',
    });

    for (const target of result.targets) {
      const absolute = pathResolver.rootResolve(target.path);
      try {
        if (!safeExistsSync(absolute)) continue;
        softDeleteToTrash(absolute);
        result.soft_deleted.push(target.path);
        appendRetentionAudit({
          event: 'SCOPE_OFFBOARD_SOFT_DELETE',
          scope_type: scopeType,
          scope_id: scopeId,
          path: target.path,
          trash_path: `${TRASH_REPO_SUBPATH}/${target.path}`,
          kind: target.kind,
          export_path: result.export_path,
          approved_by: approvedBy,
          approved_at: approvedAt,
          purpose,
          policy_ref: RETENTION_CATALOG_REPO_PATH,
          reason: 'offboarding delete after export (soft-delete, restorable)',
        });
      } catch (err) {
        logger.warn(
          `[scope-offboarding] failed to remove ${target.path}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    logger.info(
      `[scope-offboarding] ${scopeType} '${scopeId}' offboarded: ${result.soft_deleted.length} tree(s) exported to ${result.export_path} and moved to the trash`
    );
    return result;
  } catch (err) {
    result.status = 'error';
    result.reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[scope-offboarding] offboarding ${scopeType} '${scopeId}' failed: ${result.reason}`
    );
    return result;
  }
}
