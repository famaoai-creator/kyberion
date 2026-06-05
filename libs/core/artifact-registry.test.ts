import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  appendArtifactOwnershipRecord,
  findReusableArtifactOwnershipRecord,
  artifactOwnershipRegistryPath,
  createArtifactOwnershipRecord,
  listArtifactOwnershipRecordsByQuery,
  listArtifactOwnershipRecordsForProject,
  listArtifactOwnershipRecords,
} from './artifact-registry.js';

describe('artifact-registry', () => {
  const registryPath = artifactOwnershipRegistryPath();
  let originalRegistryRaw: string | null = null;

  beforeAll(() => {
    if (safeExistsSync(registryPath)) {
      originalRegistryRaw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    }
  });

  beforeEach(() => {
    if (safeExistsSync(registryPath)) safeRmSync(registryPath);
  });

  afterAll(() => {
    if (originalRegistryRaw !== null) {
      safeWriteFile(registryPath, originalRegistryRaw);
      return;
    }
    if (safeExistsSync(registryPath)) safeRmSync(registryPath);
  });

  it('appends and lists ownership records from jsonl registry', () => {
    appendArtifactOwnershipRecord(createArtifactOwnershipRecord({
      artifact_id: 'ART-TEST-ONE',
      project_id: 'PRJ-TEST',
      kind: 'pptx',
      storage_class: 'artifact_store',
      path: 'active/shared/exports/test-one.pptx',
    }));
    appendArtifactOwnershipRecord(createArtifactOwnershipRecord({
      artifact_id: 'ART-TEST-TWO',
      task_session_id: 'TSK-TEST',
      kind: 'docx',
      storage_class: 'artifact_store',
      path: 'active/shared/exports/test-two.docx',
      evidence_refs: ['artifact:ART-TEST-ONE'],
    }));

    const rows = listArtifactOwnershipRecords();
    expect(rows.length).toBe(2);
    expect(rows[0]?.artifact_id).toBe('ART-TEST-ONE');
    expect(rows[1]?.artifact_id).toBe('ART-TEST-TWO');
  });

  it('rejects records without ownership metadata', () => {
    const record = createArtifactOwnershipRecord({
      artifact_id: 'ART-TEST-NO-OWNER',
      kind: 'report',
      storage_class: 'artifact_store',
      path: 'active/shared/exports/no-owner.md',
    });
    expect(() => appendArtifactOwnershipRecord(record)).toThrow(/requires at least one owner/i);
  });

  it('rejects tmp storage artifacts for delivery registration', () => {
    const record = createArtifactOwnershipRecord({
      artifact_id: 'ART-TEST-TMP',
      task_session_id: 'TSK-TEST-TMP',
      kind: 'tmp-file',
      storage_class: 'tmp',
      path: 'active/shared/tmp/out.txt',
    });
    expect(() => appendArtifactOwnershipRecord(record, { for_delivery: true })).toThrow(/tmp storage_class/i);
  });

  it('finds reusable project artifacts and keeps mission-local artifacts scoped by query', () => {
    appendArtifactOwnershipRecord(createArtifactOwnershipRecord({
      artifact_id: 'ART-PROJ-OLD',
      project_id: 'PRJ-TEST-PROJ',
      mission_id: 'MSN-TEST-OLD',
      kind: 'markdown',
      storage_class: 'artifact_store',
      path: 'active/shared/artifacts/old.md',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    appendArtifactOwnershipRecord(createArtifactOwnershipRecord({
      artifact_id: 'ART-PROJ-NEW',
      project_id: 'PRJ-TEST-PROJ',
      mission_id: 'MSN-TEST-NEW',
      kind: 'markdown',
      storage_class: 'artifact_store',
      path: 'active/shared/artifacts/new.md',
      created_at: '2026-06-02T00:00:00.000Z',
    }));
    appendArtifactOwnershipRecord(createArtifactOwnershipRecord({
      artifact_id: 'ART-PROJ-TMP',
      project_id: 'PRJ-TEST-PROJ',
      mission_id: 'MSN-TEST-TMP',
      kind: 'markdown',
      storage_class: 'tmp',
      path: 'active/shared/tmp/tmp.md',
      created_at: '2026-06-03T00:00:00.000Z',
    }));

    expect(listArtifactOwnershipRecordsForProject('PRJ-TEST-PROJ').map((record) => record.artifact_id)).toEqual([
      'ART-PROJ-TMP',
      'ART-PROJ-NEW',
      'ART-PROJ-OLD',
    ]);
    expect(listArtifactOwnershipRecordsByQuery({ projectId: 'PRJ-TEST-PROJ', kind: 'markdown', includeTmp: false }).map((record) => record.artifact_id)).toEqual([
      'ART-PROJ-NEW',
      'ART-PROJ-OLD',
    ]);
    expect(findReusableArtifactOwnershipRecord({ projectId: 'PRJ-TEST-PROJ', kind: 'markdown' })?.artifact_id).toBe('ART-PROJ-NEW');
  });
});
