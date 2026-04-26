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

export function artifactOwnershipRegistryPath(): string {
  return ARTIFACT_REGISTRY_PATH;
}
