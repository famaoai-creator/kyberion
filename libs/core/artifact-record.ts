import type { ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { compileSchema } from './foundation/ajv.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import { loadTaskSession, saveTaskSession, type TaskSession } from './task-session.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';
import {
  appendArtifactOwnershipRecord,
  createArtifactOwnershipRecord,
} from './artifact-registry.js';
import {
  evaluateDeliverableQuality,
  inferDeliverableKind,
  qualityScoreFromReport,
} from './deliverable-quality.js';

export interface ArtifactRecord {
  artifact_id: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  track_id?: string;
  track_name?: string;
  mission_id?: string;
  task_session_id?: string;
  kind: string;
  storage_class: 'repo' | 'artifact_store' | 'vault' | 'tmp' | 'external_ref';
  path?: string;
  external_ref?: string;
  preview_text?: string;
  work_loop?: OrganizationWorkLoopSummary;
  delivered_to?: Array<{
    binding_id: string;
    status: 'pending' | 'delivered' | 'failed';
    external_url?: string;
  }>;
  metadata?: Record<string, unknown>;
}

const ARTIFACT_SCHEMA_PATH = pathResolver.knowledge('product/schemas/artifact-record.schema.json');
const ARTIFACT_DIR = pathResolver.shared('runtime/artifacts');
let artifactValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (artifactValidateFn) return artifactValidateFn;
  artifactValidateFn = compileSchema(ARTIFACT_SCHEMA_PATH);
  return artifactValidateFn;
}

function artifactPath(artifactId: string): string {
  const normalized = String(artifactId || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/u.test(normalized)) {
    throw new Error(`[artifact-record] invalid artifact id: ${artifactId}`);
  }
  return assertSafeRepositoryPath(`${ARTIFACT_DIR}/${normalized}.json`, {
    allowMissingLeaf: true,
  });
}

function artifactRecordCatalog(filePath: string) {
  return defineCatalog<ArtifactRecord>({
    id: 'artifact-record',
    path: filePath,
    schema: ARTIFACT_SCHEMA_PATH,
  });
}

export function createArtifactRecord(
  input: Omit<ArtifactRecord, 'artifact_id'> & { artifact_id?: string }
): ArtifactRecord {
  return {
    artifact_id:
      input.artifact_id ||
      `ART-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    ...input,
  };
}

export function validateArtifactRecord(value: unknown): value is ArtifactRecord {
  return Boolean(ensureValidator()(value));
}

export function saveArtifactRecord(record: ArtifactRecord): string {
  const filePath = artifactPath(record.artifact_id);
  let canonicalInput: ArtifactRecord;
  try {
    canonicalInput = artifactRecordCatalog(filePath).validate(record, filePath);
  } catch (error) {
    throw new Error(
      `Invalid artifact record: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const artifactDir = assertSafeRepositoryPath(ARTIFACT_DIR, { allowMissingLeaf: true });
  if (!safeExistsSync(artifactDir)) safeMkdir(artifactDir, { recursive: true });
  const deliverableKind = inferDeliverableKind(canonicalInput.kind);
  const qualityReport = deliverableKind
    ? evaluateDeliverableQuality(deliverableKind, {
        ...canonicalInput,
        text: canonicalInput.preview_text,
      })
    : null;
  const metadata = {
    ...(canonicalInput.metadata || {}),
    ...(qualityReport
      ? {
          quality_kind: qualityReport.kind,
          quality_verdict: qualityReport.severity,
          quality_score: qualityScoreFromReport(qualityReport),
          quality_hard_checks: [...qualityReport.hard_checks],
          quality_soft_checks: [...qualityReport.soft_checks],
        }
      : {}),
  };
  const canonicalRecord = artifactRecordCatalog(filePath).validate(
    { ...canonicalInput, metadata },
    filePath
  );
  safeWriteFile(filePath, `${JSON.stringify(canonicalRecord, null, 2)}\n`);
  appendArtifactOwnershipRecord(
    createArtifactOwnershipRecord({
      artifact_id: canonicalRecord.artifact_id,
      tenant_slug: canonicalRecord.tenant_slug,
      organization_id: canonicalRecord.organization_id,
      project_id: canonicalRecord.project_id,
      mission_id: canonicalRecord.mission_id,
      task_session_id: canonicalRecord.task_session_id,
      kind: canonicalRecord.kind,
      storage_class: canonicalRecord.storage_class,
      path: canonicalRecord.path,
      external_ref: canonicalRecord.external_ref,
      ...(canonicalRecord.metadata ? { metadata: canonicalRecord.metadata } : {}),
      evidence_refs: Array.isArray((canonicalRecord.metadata as any)?.evidence_refs)
        ? ((canonicalRecord.metadata as any).evidence_refs as string[])
        : [],
    })
  );
  return filePath;
}

export function loadArtifactRecord(artifactId: string): ArtifactRecord | null {
  const filePath = artifactPath(artifactId);
  if (!safeExistsSync(filePath)) return null;
  const parsed = artifactRecordCatalog(filePath).load();
  return validateArtifactRecord(parsed) ? parsed : null;
}

export function listArtifactRecords(): ArtifactRecord[] {
  const artifactDir = assertSafeRepositoryPath(ARTIFACT_DIR, { allowMissingLeaf: true });
  if (!safeExistsSync(artifactDir)) return [];
  return safeReaddir(artifactDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadArtifactRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is ArtifactRecord => Boolean(record))
    .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
}

export function attachArtifactRecordToTaskSession(
  sessionId: string,
  record: ArtifactRecord
): TaskSession | null {
  appendArtifactOwnershipRecord(
    createArtifactOwnershipRecord({
      artifact_id: record.artifact_id,
      project_id: record.project_id,
      mission_id: record.mission_id,
      task_session_id: record.task_session_id || sessionId,
      kind: record.kind,
      storage_class: record.storage_class,
      path: record.path,
      external_ref: record.external_ref,
      ...(record.metadata ? { metadata: record.metadata } : {}),
      evidence_refs: Array.isArray((record.metadata as any)?.evidence_refs)
        ? ((record.metadata as any).evidence_refs as string[])
        : [],
    }),
    { for_delivery: true }
  );
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  session.artifact = {
    ...(session.artifact || {}),
    kind: record.kind,
    output_path: record.path || session.artifact?.output_path,
    preview_text: record.preview_text || session.artifact?.preview_text,
    artifact_id: record.artifact_id,
    project_id: record.project_id,
    track_id: record.track_id,
    track_name: record.track_name,
    mission_id: record.mission_id,
    storage_class: record.storage_class,
    external_ref: record.external_ref,
  };
  if (record.work_loop) {
    session.work_loop = record.work_loop;
  }
  saveTaskSession(session);
  return session;
}
