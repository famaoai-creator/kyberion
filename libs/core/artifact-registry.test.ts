import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  appendArtifactOwnershipRecord,
  artifactOwnershipRegistryPath,
  createArtifactOwnershipRecord,
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
});
