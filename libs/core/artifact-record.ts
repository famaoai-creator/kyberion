import AjvModule, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import { loadTaskSession, saveTaskSession, type TaskSession } from './task-session.js';

export interface ArtifactRecord {
  artifact_id: string;
  project_id?: string;
  mission_id?: string;
  task_session_id?: string;
  kind: string;
  storage_class: 'repo' | 'artifact_store' | 'vault' | 'tmp' | 'external_ref';
  path?: string;
  external_ref?: string;
  preview_text?: string;
  delivered_to?: Array<{
    binding_id: string;
    status: 'pending' | 'delivered' | 'failed';
    external_url?: string;
  }>;
  metadata?: Record<string, unknown>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const ARTIFACT_SCHEMA_PATH = pathResolver.knowledge('public/schemas/artifact-record.schema.json');
const ARTIFACT_DIR = pathResolver.shared('runtime/artifacts');
let artifactValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (artifactValidateFn) return artifactValidateFn;
  const raw = safeReadFile(ARTIFACT_SCHEMA_PATH, { encoding: 'utf8' }) as string;
  artifactValidateFn = ajv.compile(JSON.parse(raw));
  return artifactValidateFn;
}

function artifactPath(artifactId: string): string {
  return `${ARTIFACT_DIR}/${artifactId}.json`;
}

export function createArtifactRecord(input: Omit<ArtifactRecord, 'artifact_id'> & { artifact_id?: string }): ArtifactRecord {
  return {
    artifact_id: input.artifact_id || `ART-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    ...input,
  };
}

export function validateArtifactRecord(value: unknown): value is ArtifactRecord {
  return Boolean(ensureValidator()(value));
}

export function saveArtifactRecord(record: ArtifactRecord): string {
  if (!validateArtifactRecord(record)) {
    const errors = (ensureValidator().errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    throw new Error(`Invalid artifact record: ${errors.join('; ')}`);
  }
  if (!safeExistsSync(ARTIFACT_DIR)) safeMkdir(ARTIFACT_DIR, { recursive: true });
  const filePath = artifactPath(record.artifact_id);
  safeWriteFile(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadArtifactRecord(artifactId: string): ArtifactRecord | null {
  const filePath = artifactPath(artifactId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as ArtifactRecord;
  return validateArtifactRecord(parsed) ? parsed : null;
}

export function listArtifactRecords(): ArtifactRecord[] {
  if (!safeExistsSync(ARTIFACT_DIR)) return [];
  return safeReaddir(ARTIFACT_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadArtifactRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is ArtifactRecord => Boolean(record))
    .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
}

export function attachArtifactRecordToTaskSession(sessionId: string, record: ArtifactRecord): TaskSession | null {
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  session.artifact = {
    ...(session.artifact || {}),
    kind: record.kind,
    output_path: record.path || session.artifact?.output_path,
    preview_text: record.preview_text || session.artifact?.preview_text,
    artifact_id: record.artifact_id,
    project_id: record.project_id,
    mission_id: record.mission_id,
    storage_class: record.storage_class,
    external_ref: record.external_ref,
  };
  saveTaskSession(session);
  return session;
}
