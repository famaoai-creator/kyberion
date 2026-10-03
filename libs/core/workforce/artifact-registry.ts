import * as path from 'node:path';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { withLockSync } from '../foundation/lock-utils.js';

import { ARTIFACT_KINDS, type ArtifactKind } from './artifact-kind.generated.js';

const ARTIFACT_REGISTRY_LOCK = 'artifact-ownership-registry';
/** Generous: a concurrent compaction rewrite must never fail a publication. */
const APPEND_LOCK_TIMEOUT_MS = 30_000;
export { ARTIFACT_KINDS, type ArtifactKind } from './artifact-kind.generated.js';

export interface ArtifactOwnershipRecord {
  artifact_id: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  task_session_id?: string;
  kind: ArtifactKind;
  storage_class: 'repo' | 'artifact_store' | 'vault' | 'tmp' | 'external_ref';
  path?: string;
  external_ref?: string;
  created_at: string;
  evidence_refs: string[];
  metadata?: Record<string, unknown>;
}

export interface ArtifactOwnershipQuery {
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
  missionId?: string;
  taskSessionId?: string;
  kind?: string;
  storageClass?:
    ArtifactOwnershipRecord['storage_class'] | ArtifactOwnershipRecord['storage_class'][];
  includeTmp?: boolean;
}

function artifactRegistryPath(): string {
  return assertSafeRepositoryPath(pathResolver.shared('runtime/artifacts/registry.jsonl'), {
    allowMissingLeaf: true,
  });
}

function ensureArtifactRegistryFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`[ARTIFACT_REGISTRY] registry must be a regular file: ${filePath}`);
  }
}

function artifactOwnershipCatalog(filePath: string) {
  return defineCatalog<ArtifactOwnershipRecord>({
    id: 'artifact-ownership-record',
    path: filePath,
    schema: pathResolver.knowledge('product/schemas/artifact-ownership-record.schema.json'),
  });
}

function hasOwnership(record: ArtifactOwnershipRecord): boolean {
  return Boolean(
    record.project_id || record.mission_id || record.organization_id || record.task_session_id
  );
}

function normalizeStorageClasses(
  storageClass?: ArtifactOwnershipQuery['storageClass']
): ArtifactOwnershipRecord['storage_class'][] {
  if (!storageClass) return [];
  return (Array.isArray(storageClass) ? storageClass : [storageClass])
    .map((value) => String(value).trim() as ArtifactOwnershipRecord['storage_class'])
    .filter(Boolean);
}

function matchesQuery(record: ArtifactOwnershipRecord, query: ArtifactOwnershipQuery): boolean {
  if (query.tenantSlug && record.tenant_slug !== query.tenantSlug) return false;
  if (query.organizationId && record.organization_id !== query.organizationId) return false;
  if (query.projectId && record.project_id !== query.projectId) return false;
  if (query.missionId && record.mission_id !== query.missionId) return false;
  if (query.taskSessionId && record.task_session_id !== query.taskSessionId) return false;
  if (query.kind && record.kind !== query.kind) return false;
  const storageClasses = normalizeStorageClasses(query.storageClass);
  if (storageClasses.length > 0 && !storageClasses.includes(record.storage_class)) return false;
  if (query.includeTmp === false && record.storage_class === 'tmp') return false;
  return true;
}

function compareArtifactOwnershipRecords(
  a: ArtifactOwnershipRecord,
  b: ArtifactOwnershipRecord
): number {
  const createdAtCompare = String(b.created_at || '').localeCompare(String(a.created_at || ''));
  if (createdAtCompare !== 0) return createdAtCompare;
  return String(b.artifact_id || '').localeCompare(String(a.artifact_id || ''));
}

function canonicalArtifactOwnershipRecord(
  record: ArtifactOwnershipRecord
): ArtifactOwnershipRecord {
  const registryPath = artifactRegistryPath();
  return artifactOwnershipCatalog(registryPath).validate(record, registryPath);
}

export function createArtifactOwnershipRecord(
  input: Omit<ArtifactOwnershipRecord, 'created_at' | 'evidence_refs'> & {
    created_at?: string;
    evidence_refs?: string[];
  }
): ArtifactOwnershipRecord {
  return {
    ...input,
    created_at: input.created_at || nowIso(),
    evidence_refs: (input.evidence_refs || []).map((value) => String(value).trim()).filter(Boolean),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function validateArtifactOwnershipRecord(record: ArtifactOwnershipRecord): {
  valid: boolean;
  errors: string[];
} {
  try {
    canonicalArtifactOwnershipRecord(record);
    return { valid: true, errors: [] };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function appendArtifactOwnershipRecord(
  record: ArtifactOwnershipRecord,
  options: { for_delivery?: boolean } = {}
): string {
  if (!hasOwnership(record)) {
    throw new Error(
      'Artifact ownership record requires at least one owner: project_id, mission_id, organization_id, or task_session_id.'
    );
  }
  if (options.for_delivery && record.storage_class === 'tmp') {
    throw new Error('tmp storage_class cannot be registered as a delivery artifact.');
  }
  let validated: ArtifactOwnershipRecord;
  try {
    validated = canonicalArtifactOwnershipRecord(record);
  } catch (error) {
    throw new Error(
      `Invalid artifact ownership record: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const registryPath = artifactRegistryPath();
  const registryDir = assertSafeRepositoryPath(path.dirname(registryPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(registryDir)) safeMkdir(registryDir, { recursive: true });
  // Appends and compaction share one lock: a compaction rewrite never drops a
  // row appended while it ran.
  withLockSync(
    ARTIFACT_REGISTRY_LOCK,
    () => {
      ensureArtifactRegistryFile(registryPath);
      appendJsonLine(registryPath, validated);
    },
    APPEND_LOCK_TIMEOUT_MS
  );
  return registryPath;
}

export function listArtifactOwnershipRecords(): ArtifactOwnershipRecord[] {
  const registryPath = artifactRegistryPath();
  if (!safeExistsSync(registryPath)) return [];
  ensureArtifactRegistryFile(registryPath);
  try {
    return readJsonLines<ArtifactOwnershipRecord>(registryPath, {
      map: (value) => artifactOwnershipCatalog(registryPath).validate(value, registryPath),
    });
  } catch (error) {
    // The registry is shared runtime state. A concurrent cleanup can remove it
    // after the existence check; treat that race like an empty registry.
    if (error instanceof Error && error.message.startsWith('File not found:')) return [];
    throw error;
  }
}

/**
 * The registry is append-only: re-registering an artifact (re-publish, mission
 * → project promotion, a deterministic-id update) appends a new row. The
 * current ownership of each artifact is its LAST row; keep it in the order of
 * that last write. `listArtifactOwnershipRecords` stays the raw history.
 */
function latestByArtifactId(records: ArtifactOwnershipRecord[]): ArtifactOwnershipRecord[] {
  const latest = new Map<string, ArtifactOwnershipRecord>();
  for (const record of records) {
    latest.delete(record.artifact_id);
    latest.set(record.artifact_id, record);
  }
  return [...latest.values()];
}

/**
 * Latest row per (artifact_id, owner). Keeps every distinct owner an artifact
 * ever had — offboarding counts that history — while the artifact's overall
 * latest row stays last among its rows, so latestByArtifactId is unchanged.
 */
function latestByArtifactOwner(records: ArtifactOwnershipRecord[]): ArtifactOwnershipRecord[] {
  const latest = new Map<string, ArtifactOwnershipRecord>();
  for (const record of records) {
    const key = JSON.stringify([
      record.artifact_id,
      record.tenant_slug ?? '',
      record.organization_id ?? '',
      record.project_id ?? '',
      record.mission_id ?? '',
      record.task_session_id ?? '',
    ]);
    latest.delete(key);
    latest.set(key, record);
  }
  return [...latest.values()];
}

/** Current ownership: one row per artifact_id (its latest). */
export function listLatestArtifactOwnershipRecords(): ArtifactOwnershipRecord[] {
  return latestByArtifactId(listArtifactOwnershipRecords());
}

export function listArtifactOwnershipRecordsByQuery(
  query: ArtifactOwnershipQuery = {}
): ArtifactOwnershipRecord[] {
  // De-duplicate BEFORE filtering: a superseded row (e.g. the mission owner of
  // a deliverable since promoted to its project) must not still match.
  return listLatestArtifactOwnershipRecords()
    .filter((record) => matchesQuery(record, query))
    .sort(compareArtifactOwnershipRecords);
}

/**
 * Every artifact any row of the history attributes to the query (current or
 * superseded owner), latest row per artifact. For offboarding / audit, where an
 * artifact once owned by a tenant still counts after it was re-registered.
 */
export function listArtifactOwnershipHistoryByQuery(
  query: ArtifactOwnershipQuery = {}
): ArtifactOwnershipRecord[] {
  const rows = listArtifactOwnershipRecords();
  const matchedIds = new Set(
    rows.filter((record) => matchesQuery(record, query)).map((record) => record.artifact_id)
  );
  return latestByArtifactId(rows)
    .filter((record) => matchedIds.has(record.artifact_id))
    .sort(compareArtifactOwnershipRecords);
}

export interface ArtifactOwnershipCompaction {
  total_rows: number;
  kept_rows: number;
  removed_rows: number;
  applied: boolean;
}

/**
 * Rewrite the registry to its latest row per artifact_id and owner: repeated
 * re-registrations collapse, an earlier owner's row survives so ownership
 * history (offboarding) is not lost. Dry run by default
 * (reports what would be removed). Runs under the append lock, so no row
 * appended concurrently is lost.
 */
export function compactArtifactOwnershipRegistry(
  options: { dryRun?: boolean } = {}
): ArtifactOwnershipCompaction {
  const dryRun = options.dryRun ?? true;
  const registryPath = artifactRegistryPath();
  const plan = (): { rows: number; kept: ArtifactOwnershipRecord[] } => {
    const rows = listArtifactOwnershipRecords();
    return { rows: rows.length, kept: latestByArtifactOwner(rows) };
  };
  const summarize = (
    { rows, kept }: { rows: number; kept: ArtifactOwnershipRecord[] },
    applied: boolean
  ): ArtifactOwnershipCompaction => ({
    total_rows: rows,
    kept_rows: kept.length,
    removed_rows: rows - kept.length,
    applied,
  });
  // A dry run only reads: it never blocks publications.
  const preview = plan();
  if (dryRun || preview.rows === preview.kept.length) return summarize(preview, false);
  return withLockSync(ARTIFACT_REGISTRY_LOCK, () => {
    // Re-read under the lock: rows appended since the preview are kept.
    const current = plan();
    if (current.rows === current.kept.length) return summarize(current, false);
    safeWriteFile(registryPath, `${current.kept.map((row) => JSON.stringify(row)).join('\n')}\n`);
    return summarize(current, true);
  });
}

export function listArtifactOwnershipRecordsForProject(
  projectId: string,
  query: Omit<ArtifactOwnershipQuery, 'projectId'> = {}
): ArtifactOwnershipRecord[] {
  return listArtifactOwnershipRecordsByQuery({ ...query, projectId });
}

export function listArtifactOwnershipRecordsForMission(
  missionId: string,
  query: Omit<ArtifactOwnershipQuery, 'missionId'> = {}
): ArtifactOwnershipRecord[] {
  return listArtifactOwnershipRecordsByQuery({ ...query, missionId });
}

export function findReusableArtifactOwnershipRecord(
  query: ArtifactOwnershipQuery & { projectId?: string }
): ArtifactOwnershipRecord | null {
  const records = listArtifactOwnershipRecordsByQuery({
    ...query,
    includeTmp: query.includeTmp ?? false,
  });
  return records.length ? records[0] : null;
}

export function artifactOwnershipRegistryPath(): string {
  return artifactRegistryPath();
}

/** Validate artifact vocabulary against its governed schema instead of casting strings. */
export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}
