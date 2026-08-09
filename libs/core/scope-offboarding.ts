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
import { listArtifactOwnershipRecordsByQuery } from './artifact-registry.js';
import {
  appendRetentionAudit,
  repoRelativePosix,
  softDeleteToTrash,
  TRASH_REPO_SUBPATH,
} from './storage-janitor.js';
import { RETENTION_CATALOG_REPO_PATH } from './storage-retention-catalog.js';
import { retireIdentitiesForScopeBestEffort } from './nhi-lifecycle-governance.js';

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

export type OffboardTargetKind =
  | 'project_tree'
  | 'mission_tree'
  /** DA-08: the tenant's governed knowledge root incl. its `_ledger/` asset ledger (DA-05). */
  | 'tenant_knowledge_tree'
  /** DA-08: the tenant's incremental-sync cursor subtree (DA-03). */
  | 'ingest_cursors_tree'
  /** DA-08: one data-vault cache entry whose projectId equals the scope id. */
  | 'data_vault_entry';

export interface OffboardTarget {
  /** Repo-relative POSIX path. */
  path: string;
  kind: OffboardTargetKind;
}

/** DA-08: dedup-registry line prune summary (tenant offboarding). */
export interface OffboardDedupRegistryResult {
  /** Lines identified as belonging to the tenant (ledger hashes / source ids / landing prefix). */
  matched: number;
  /** Lines actually removed (execute mode only; 0 on dry run). */
  removed: number;
  /** Repo-relative copy of the removed lines inside the export directory. */
  export_file?: string;
}

/** DA-08: post-execute leftover check (受入条件: 痕跡が残らない). */
export interface OffboardVerification {
  clean: boolean;
  /** Repo-relative paths (or annotated registry refs) still carrying scope traces. */
  leftovers: string[];
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
  /** NI-05: identities auto-retired because their scope closed (execute mode only). */
  retired_identities?: number;
  /** DA-08: dedup-registry prune summary (tenant scope only). */
  dedup_registry?: OffboardDedupRegistryResult;
  /** EG-10: registry-backed artifact ownership query for the offboarded scope. */
  artifact_registry?: { matched: number; registry_path: string; records_retained: boolean };
  /** DA-08: automatic post-execute leftover check (execute mode only). */
  verification?: OffboardVerification;
  reason?: string;
}

/** Where offboarding exports land, under the catalog's `active/shared/exports` tree. */
export const OFFBOARDING_EXPORT_SUBDIR = 'offboarding';

/**
 * DA-08 ingest-system residue locations. Kept as literals (not imports from
 * the ingest modules) so this lifecycle verb has no module-load coupling to
 * the ingest stack; they mirror `ingest-quota.ts` / the ingest-actuator dedup
 * registry / the DA-03 sync cursor store and the retention-catalog entries.
 */
export const INGEST_CURSORS_REPO_SUBPATH = 'active/shared/runtime/ingest-cursors';
export const INGEST_DEDUP_REGISTRY_REPO_PATH =
  'active/shared/runtime/ingest/content-hash-registry.jsonl';
const INGEST_QUOTA_REPO_SUBPATH = 'active/shared/runtime/ingest/quota';
const DATA_VAULT_REPO_SUBPATH = 'active/shared/data-vault';

const SCOPE_TIERS = ['personal', 'confidential', 'public'] as const;

/**
 * Repo-relative knowledge root for a tenant slug. Deliberately the
 * tenant-registry DEFAULT (`knowledge/confidential/{slug}`) rather than a
 * `resolveTenant` call: offboarding must keep working for tenants whose
 * profile is already gone/invalid, and importing tenant-registry would bind
 * this module's load to schema files. Profiles that declare a custom
 * `knowledge_root` are not resolved here (none exist today) — their tree
 * would surface via the janitor's coverage reporting, not silently vanish.
 */
function tenantKnowledgeRootDefault(tenantSlug: string): string {
  return `knowledge/confidential/${tenantSlug}`;
}

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

/** Data-vault entry files (`active/shared/data-vault/*.json`) whose projectId equals the scope id. */
function collectDataVaultEntryTargets(scopeId: string): OffboardTarget[] {
  const targets: OffboardTarget[] = [];
  const vaultDir = pathResolver.shared('data-vault');
  for (const name of listDirEntries(vaultDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(vaultDir, name);
    const record = readJsonRecord(filePath);
    if (record && typeof record.projectId === 'string' && record.projectId === scopeId) {
      targets.push({ path: repoRelativePosix(filePath), kind: 'data_vault_entry' });
    }
  }
  return targets;
}

/**
 * Everything that belongs to the scope: its project workspace tree(s), every
 * mission declaring it, and — for a tenant (DA-08) — the tenant's governed
 * knowledge root (incl. the DA-05 `_ledger/`), its ingest sync-cursor and
 * quota-counter subtrees, plus data-vault entries keyed by the scope id.
 * Data-vault entries use `VaultEntry.projectId` for both scope types — a
 * tenant that cached vault data under a projectId different from its slug is
 * NOT matched here (the projectId is the only scope key the vault carries).
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

  // DA-08 tenant residue: governed knowledge (with the asset ledger inside),
  // sync cursors, and quota counters.
  if (scopeType === 'tenant') {
    const knowledgeRoot = tenantKnowledgeRootDefault(id);
    if (safeExistsSync(pathResolver.rootResolve(knowledgeRoot))) {
      targets.push({ path: knowledgeRoot, kind: 'tenant_knowledge_tree' });
    }
    for (const subtree of [
      `${INGEST_CURSORS_REPO_SUBPATH}/${id}`,
      `${INGEST_QUOTA_REPO_SUBPATH}/${id}`,
    ]) {
      if (safeExistsSync(pathResolver.rootResolve(subtree))) {
        targets.push({ path: subtree, kind: 'ingest_cursors_tree' });
      }
    }
  }

  // DA-08 data-vault entries keyed by the scope id (both scope types — the
  // vault's only scope dimension is projectId).
  targets.push(...collectDataVaultEntryTargets(id));

  return targets;
}

// ---------------------------------------------------------------------------
// DA-08: dedup-registry prune + post-offboard verification
// ---------------------------------------------------------------------------

interface LedgerAssetLine {
  content_sha256?: string;
  source_system?: string;
  source_id?: string;
}

/** Parse a JSONL file leniently (corrupt lines skipped — same contract as the ingest readers). */
function readJsonlLines(absPath: string): Array<Record<string, unknown>> {
  if (!safeExistsSync(absPath)) return [];
  const raw = String(safeReadFile(absPath, { encoding: 'utf8' }) || '');
  const records: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') records.push(parsed as Record<string, unknown>);
    } catch {
      /* skip corrupt line */
    }
  }
  return records;
}

interface DedupRegistryPrune {
  /** Registry lines that belong to the tenant, verbatim (for the export copy). */
  removedLines: string[];
  /** Every other line, verbatim, in original order. */
  keptLines: string[];
}

/**
 * Which dedup-registry lines belong to this tenant? A line matches when its
 * content hash or source identity appears in the tenant's asset ledger, or
 * when its recorded landing path points into the tenant knowledge root. Must
 * be computed BEFORE the knowledge tree (and with it the ledger) is deleted.
 */
function computeDedupRegistryPrune(tenantSlug: string): DedupRegistryPrune {
  const registryAbs = pathResolver.rootResolve(INGEST_DEDUP_REGISTRY_REPO_PATH);
  const result: DedupRegistryPrune = { removedLines: [], keptLines: [] };
  if (!safeExistsSync(registryAbs)) return result;

  const knowledgeRoot = tenantKnowledgeRootDefault(tenantSlug);
  const ledgerLines = readJsonlLines(
    pathResolver.rootResolve(`${knowledgeRoot}/_ledger/assets.jsonl`)
  ) as LedgerAssetLine[];
  const hashes = new Set<string>();
  const sourcePairs = new Set<string>();
  for (const line of ledgerLines) {
    if (typeof line.content_sha256 === 'string') hashes.add(line.content_sha256);
    if (typeof line.source_system === 'string' && typeof line.source_id === 'string') {
      sourcePairs.add(`${line.source_system}::${line.source_id}`);
    }
  }

  const raw = String(safeReadFile(registryAbs, { encoding: 'utf8' }) || '');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let matches = false;
    try {
      const record = JSON.parse(trimmed) as {
        content_sha256?: string;
        source_system?: string;
        source_id?: string;
        target_path?: string;
      };
      matches =
        (typeof record.content_sha256 === 'string' && hashes.has(record.content_sha256)) ||
        (typeof record.source_id === 'string' &&
          sourcePairs.has(`${record.source_system ?? ''}::${record.source_id}`)) ||
        (typeof record.target_path === 'string' &&
          (record.target_path === knowledgeRoot ||
            record.target_path.startsWith(`${knowledgeRoot}/`)));
    } catch {
      /* corrupt line: keep it — the registry readers skip it anyway */
    }
    (matches ? result.removedLines : result.keptLines).push(trimmed);
  }
  return result;
}

/**
 * DA-08 acceptance check: does ANY trace of the scope remain (active/ trees,
 * tenant knowledge + ledger, sync cursors, quota counters, data-vault
 * entries, dedup-registry lines still pointing into the tenant knowledge
 * root)? Run automatically after an execute; also callable standalone as the
 * `--verify` half of the ceremony. Post-delete the ledger no longer exists,
 * so registry leftovers are detected by landing-path prefix — the strongest
 * signal still derivable without it.
 */
export function verifyScopeOffboarded(
  scopeType: OffboardScopeType,
  scopeId: string
): OffboardVerification {
  const id = String(scopeId || '').trim();
  const leftovers: string[] = collectScopeTargets(scopeType, id).map((target) => target.path);

  if (scopeType === 'tenant' && id) {
    const knowledgeRoot = tenantKnowledgeRootDefault(id);
    const registryLeft = readJsonlLines(
      pathResolver.rootResolve(INGEST_DEDUP_REGISTRY_REPO_PATH)
    ).filter((record) => {
      const targetPath = record.target_path;
      return (
        typeof targetPath === 'string' &&
        (targetPath === knowledgeRoot || targetPath.startsWith(`${knowledgeRoot}/`))
      );
    }).length;
    if (registryLeft > 0) {
      leftovers.push(
        `${INGEST_DEDUP_REGISTRY_REPO_PATH} (${registryLeft} line(s) referencing ${knowledgeRoot})`
      );
    }
  }

  return { clean: leftovers.length === 0, leftovers };
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
    const ownedArtifacts = listArtifactOwnershipRecordsByQuery(
      scopeType === 'tenant' ? { tenantSlug: scopeId } : { projectId: scopeId }
    );
    if (ownedArtifacts.length > 0) {
      result.artifact_registry = {
        matched: ownedArtifacts.length,
        registry_path: repoRelativePosix(pathResolver.shared('runtime/artifacts/registry.jsonl')),
        records_retained: true,
      };
    }
    // DA-08: dedup-registry lines are pruned in place (line-level, not a
    // tree), so they ride next to `targets`. Computed while the ledger still
    // exists — this must precede any deletion.
    const dedupPrune = scopeType === 'tenant' ? computeDedupRegistryPrune(scopeId) : null;
    if (dedupPrune && dedupPrune.removedLines.length > 0) {
      result.dedup_registry = { matched: dedupPrune.removedLines.length, removed: 0 };
    }
    if (result.targets.length === 0 && !result.dedup_registry && !result.artifact_registry) {
      result.status = 'not_found';
      result.reason = `no scope-owned trees or entries found for ${scopeType} '${scopeId}'`;
      return result;
    }

    if (mode !== 'execute') {
      appendRetentionAudit({
        event: 'SCOPE_OFFBOARD_DRY_RUN',
        scope_type: scopeType,
        scope_id: scopeId,
        targets: result.targets.map((target) => target.path),
        ...(result.dedup_registry ? { dedup_registry_matched: result.dedup_registry.matched } : {}),
        ...(result.artifact_registry
          ? { artifact_registry_matched: result.artifact_registry.matched }
          : {}),
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
    // DA-08: the tenant's dedup-registry lines are exported verbatim too —
    // the prune below removes them from the shared registry, and the export
    // is the recoverable copy (the registry file itself is shared across
    // tenants, so it never goes to the trash wholesale).
    const dedupExportFile = 'dedup-registry-removed.jsonl';
    if (dedupPrune && dedupPrune.removedLines.length > 0) {
      safeWriteFile(
        path.join(exportDirAbs, dedupExportFile),
        `${dedupPrune.removedLines.join('\n')}\n`
      );
      result.dedup_registry = {
        matched: dedupPrune.removedLines.length,
        removed: 0,
        export_file: `${result.export_path}/${dedupExportFile}`,
      };
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
          ...(result.dedup_registry ? { dedup_registry: result.dedup_registry } : {}),
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

    // DA-08: prune the tenant's lines out of the shared dedup registry
    // (exported above). Audited like every other purge in this ceremony.
    if (dedupPrune && dedupPrune.removedLines.length > 0) {
      const registryAbs = pathResolver.rootResolve(INGEST_DEDUP_REGISTRY_REPO_PATH);
      safeWriteFile(
        registryAbs,
        dedupPrune.keptLines.length > 0 ? `${dedupPrune.keptLines.join('\n')}\n` : ''
      );
      if (result.dedup_registry) {
        result.dedup_registry.removed = dedupPrune.removedLines.length;
      }
      appendRetentionAudit({
        event: 'SCOPE_OFFBOARD_DEDUP_REGISTRY_PRUNE',
        scope_type: scopeType,
        scope_id: scopeId,
        path: INGEST_DEDUP_REGISTRY_REPO_PATH,
        removed_lines: dedupPrune.removedLines.length,
        kept_lines: dedupPrune.keptLines.length,
        export_path: result.export_path,
        approved_by: approvedBy,
        approved_at: approvedAt,
        purpose,
        policy_ref: RETENTION_CATALOG_REPO_PATH,
        reason: 'offboarding removed the tenant’s dedup-registry lines after export (DA-08)',
      });
    }

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

    // NI-05: the scope is gone — so are the identities affiliated with it
    // (OWASP NHI #1). Best-effort and idempotent, like the mission hooks.
    const retiredIdentities = retireIdentitiesForScopeBestEffort({
      scope: scopeType,
      scopeId,
      reason: `${scopeType} '${scopeId}' offboarded (approved by ${approvedBy})`,
    });
    result.retired_identities = retiredIdentities;

    // DA-08 acceptance: prove there is no trace left. Best-effort — a
    // verification failure is reported, never thrown.
    try {
      result.verification = verifyScopeOffboarded(scopeType, scopeId);
      appendRetentionAudit({
        event: 'SCOPE_OFFBOARD_VERIFIED',
        scope_type: scopeType,
        scope_id: scopeId,
        clean: result.verification.clean,
        leftovers: result.verification.leftovers,
        policy_ref: RETENTION_CATALOG_REPO_PATH,
        reason: result.verification.clean
          ? 'post-offboard verification found no scope traces'
          : 'post-offboard verification found leftovers — operator attention required',
      });
      if (!result.verification.clean) {
        logger.warn(
          `[scope-offboarding] post-offboard verification for ${scopeType} '${scopeId}' found ` +
            `leftovers: ${result.verification.leftovers.join(', ')}`
        );
      }
    } catch (err) {
      logger.warn(
        `[scope-offboarding] post-offboard verification failed for ${scopeType} '${scopeId}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    logger.info(
      `[scope-offboarding] ${scopeType} '${scopeId}' offboarded: ${result.soft_deleted.length} tree(s) exported to ${result.export_path} and moved to the trash, ${retiredIdentities} identity(ies) retired`
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
