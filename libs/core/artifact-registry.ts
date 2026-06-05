import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';

export interface ArtifactOwnershipRecord {
  artifact_id: string;
  project_id?: string;
  mission_id?: string;
  task_session_id?: string;
  kind: string;
  storage_class: 'repo' | 'artifact_store' | 'vault' | 'tmp' | 'external_ref';
  path?: string;
  external_ref?: string;
  created_at: string;
  evidence_refs: string[];
}

export interface ArtifactOwnershipQuery {
  projectId?: string;
  missionId?: string;
  taskSessionId?: string;
  kind?: string;
  storageClass?: ArtifactOwnershipRecord['storage_class'] | ArtifactOwnershipRecord['storage_class'][];
  includeTmp?: boolean;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const ARTIFACT_OWNERSHIP_SCHEMA_PATH = pathResolver.rootResolve('schemas/artifact-record.schema.json');
const ARTIFACT_REGISTRY_PATH = pathResolver.shared('runtime/artifacts/registry.jsonl');

let artifactOwnershipValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (artifactOwnershipValidateFn) return artifactOwnershipValidateFn;
  artifactOwnershipValidateFn = compileSchemaFromPath(ajv, ARTIFACT_OWNERSHIP_SCHEMA_PATH);
  return artifactOwnershipValidateFn;
}

function hasOwnership(record: ArtifactOwnershipRecord): boolean {
  return Boolean(record.project_id || record.mission_id || record.task_session_id);
}

function parseJsonl(raw: string): ArtifactOwnershipRecord[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArtifactOwnershipRecord);
}

function normalizeStorageClasses(storageClass?: ArtifactOwnershipQuery['storageClass']): ArtifactOwnershipRecord['storage_class'][] {
  if (!storageClass) return [];
  return (Array.isArray(storageClass) ? storageClass : [storageClass]).map((value) => String(value).trim() as ArtifactOwnershipRecord['storage_class']).filter(Boolean);
}

function matchesQuery(record: ArtifactOwnershipRecord, query: ArtifactOwnershipQuery): boolean {
  if (query.projectId && record.project_id !== query.projectId) return false;
  if (query.missionId && record.mission_id !== query.missionId) return false;
  if (query.taskSessionId && record.task_session_id !== query.taskSessionId) return false;
  if (query.kind && record.kind !== query.kind) return false;
  const storageClasses = normalizeStorageClasses(query.storageClass);
  if (storageClasses.length > 0 && !storageClasses.includes(record.storage_class)) return false;
  if (query.includeTmp === false && record.storage_class === 'tmp') return false;
  return true;
}

function compareArtifactOwnershipRecords(a: ArtifactOwnershipRecord, b: ArtifactOwnershipRecord): number {
  const createdAtCompare = String(b.created_at || '').localeCompare(String(a.created_at || ''));
  if (createdAtCompare !== 0) return createdAtCompare;
  return String(b.artifact_id || '').localeCompare(String(a.artifact_id || ''));
}

export function createArtifactOwnershipRecord(input: Omit<ArtifactOwnershipRecord, 'created_at' | 'evidence_refs'> & {
  created_at?: string;
  evidence_refs?: string[];
}): ArtifactOwnershipRecord {
  return {
    ...input,
    created_at: input.created_at || new Date().toISOString(),
    evidence_refs: (input.evidence_refs || []).map((value) => String(value).trim()).filter(Boolean),
  };
}

export function validateArtifactOwnershipRecord(record: ArtifactOwnershipRecord): { valid: boolean; errors: string[] } {
  const validate = ensureValidator();
  const valid = validate(record);
  const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
  return { valid: Boolean(valid), errors };
}

export function appendArtifactOwnershipRecord(
  record: ArtifactOwnershipRecord,
  options: { for_delivery?: boolean } = {},
): string {
  if (!hasOwnership(record)) {
    throw new Error('Artifact ownership record requires at least one owner: project_id, mission_id, or task_session_id.');
  }
  if (options.for_delivery && record.storage_class === 'tmp') {
    throw new Error('tmp storage_class cannot be registered as a delivery artifact.');
  }
  const validation = validateArtifactOwnershipRecord(record);
  if (!validation.valid) {
    throw new Error(`Invalid artifact ownership record: ${validation.errors.join('; ')}`);
  }

  const registryDir = pathResolver.shared('runtime/artifacts');
  if (!safeExistsSync(registryDir)) safeMkdir(registryDir, { recursive: true });
  safeAppendFileSync(ARTIFACT_REGISTRY_PATH, `${JSON.stringify(record)}\n`);
  return ARTIFACT_REGISTRY_PATH;
}

export function listArtifactOwnershipRecords(): ArtifactOwnershipRecord[] {
  if (!safeExistsSync(ARTIFACT_REGISTRY_PATH)) return [];
  const raw = safeReadFile(ARTIFACT_REGISTRY_PATH, { encoding: 'utf8' }) as string;
  return parseJsonl(raw);
}

export function listArtifactOwnershipRecordsByQuery(query: ArtifactOwnershipQuery = {}): ArtifactOwnershipRecord[] {
  return listArtifactOwnershipRecords()
    .filter((record) => matchesQuery(record, query))
    .sort(compareArtifactOwnershipRecords);
}

export function listArtifactOwnershipRecordsForProject(projectId: string, query: Omit<ArtifactOwnershipQuery, 'projectId'> = {}): ArtifactOwnershipRecord[] {
  return listArtifactOwnershipRecordsByQuery({ ...query, projectId });
}

export function listArtifactOwnershipRecordsForMission(missionId: string, query: Omit<ArtifactOwnershipQuery, 'missionId'> = {}): ArtifactOwnershipRecord[] {
  return listArtifactOwnershipRecordsByQuery({ ...query, missionId });
}

export function findReusableArtifactOwnershipRecord(query: ArtifactOwnershipQuery & { projectId?: string }): ArtifactOwnershipRecord | null {
  const records = listArtifactOwnershipRecordsByQuery({
    ...query,
    includeTmp: query.includeTmp ?? false,
  });
  return records.length ? records[0] : null;
}

export function artifactOwnershipRegistryPath(): string {
  return ARTIFACT_REGISTRY_PATH;
}
