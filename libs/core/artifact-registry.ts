import * as path from 'node:path';
import { appendJsonLine, readJsonLines } from './foundation/json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from './secure-io.js';

export interface ArtifactOwnershipRecord {
  artifact_id: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  task_session_id?: string;
  kind: string;
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

function artifactOwnershipCatalog(filePath: string) {
  return defineCatalog<ArtifactOwnershipRecord>({
    id: 'artifact-ownership-record',
    path: filePath,
    schema: pathResolver.knowledge('product/schemas/artifact-ownership-record.schema.json'),
  });
}

function hasOwnership(record: ArtifactOwnershipRecord): boolean {
  return Boolean(record.project_id || record.mission_id || record.task_session_id);
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
    artifactOwnershipCatalog(artifactRegistryPath()).validate(record);
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
      'Artifact ownership record requires at least one owner: project_id, mission_id, or task_session_id.'
    );
  }
  if (options.for_delivery && record.storage_class === 'tmp') {
    throw new Error('tmp storage_class cannot be registered as a delivery artifact.');
  }
  const validation = validateArtifactOwnershipRecord(record);
  if (!validation.valid) {
    throw new Error(`Invalid artifact ownership record: ${validation.errors.join('; ')}`);
  }

  const registryPath = artifactRegistryPath();
  const registryDir = assertSafeRepositoryPath(path.dirname(registryPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(registryDir)) safeMkdir(registryDir, { recursive: true });
  appendJsonLine(registryPath, record);
  return registryPath;
}

export function listArtifactOwnershipRecords(): ArtifactOwnershipRecord[] {
  const registryPath = artifactRegistryPath();
  if (!safeExistsSync(registryPath)) return [];
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

export function listArtifactOwnershipRecordsByQuery(
  query: ArtifactOwnershipQuery = {}
): ArtifactOwnershipRecord[] {
  return listArtifactOwnershipRecords()
    .filter((record) => matchesQuery(record, query))
    .sort(compareArtifactOwnershipRecords);
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
