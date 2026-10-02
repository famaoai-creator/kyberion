import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  appendArtifactOwnershipRecord,
  findReusableArtifactOwnershipRecord,
  artifactOwnershipRegistryPath,
  createArtifactOwnershipRecord,
  listArtifactOwnershipRecordsByQuery,
  listArtifactOwnershipRecordsForProject,
  listArtifactOwnershipRecords,
  listArtifactOwnershipRecordsForMission,
  listLatestArtifactOwnershipRecords,
  compactArtifactOwnershipRegistry,
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
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-TEST-ONE',
        project_id: 'PRJ-TEST',
        kind: 'pptx',
        storage_class: 'artifact_store',
        path: 'active/shared/exports/test-one.pptx',
      })
    );
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-TEST-TWO',
        task_session_id: 'TSK-TEST',
        kind: 'docx',
        storage_class: 'artifact_store',
        path: 'active/shared/exports/test-two.docx',
        evidence_refs: ['artifact:ART-TEST-ONE'],
      })
    );

    const rows = listArtifactOwnershipRecords();
    expect(rows.length).toBe(2);
    expect(rows[0]?.artifact_id).toBe('ART-TEST-ONE');
    expect(rows[1]?.artifact_id).toBe('ART-TEST-TWO');
  });

  it('appends the canonical ownership payload returned by the catalog', () => {
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-TEST-CANONICAL',
        project_id: 'PRJ-TEST',
        kind: 'report',
        storage_class: 'artifact_store',
        path: 'active/shared/exports/canonical.md',
        $schema: 'governance-metadata',
      } as unknown as Parameters<typeof createArtifactOwnershipRecord>[0])
    );

    const persisted = JSON.parse(
      String(safeReadFile(registryPath, { encoding: 'utf8' })).trim()
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('$schema');
    expect(persisted.artifact_id).toBe('ART-TEST-CANONICAL');
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
    expect(() => appendArtifactOwnershipRecord(record, { for_delivery: true })).toThrow(
      /tmp storage_class/i
    );
  });

  it('finds reusable project artifacts and keeps mission-local artifacts scoped by query', () => {
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-PROJ-OLD',
        project_id: 'PRJ-TEST-PROJ',
        mission_id: 'MSN-TEST-OLD',
        kind: 'markdown',
        storage_class: 'artifact_store',
        path: 'active/shared/artifacts/old.md',
        created_at: '2026-06-01T00:00:00.000Z',
      })
    );
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-PROJ-NEW',
        project_id: 'PRJ-TEST-PROJ',
        mission_id: 'MSN-TEST-NEW',
        kind: 'markdown',
        storage_class: 'artifact_store',
        path: 'active/shared/artifacts/new.md',
        created_at: '2026-06-02T00:00:00.000Z',
      })
    );
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-PROJ-TMP',
        project_id: 'PRJ-TEST-PROJ',
        mission_id: 'MSN-TEST-TMP',
        kind: 'markdown',
        storage_class: 'tmp',
        path: 'active/shared/tmp/tmp.md',
        created_at: '2026-06-03T00:00:00.000Z',
      })
    );

    expect(
      listArtifactOwnershipRecordsForProject('PRJ-TEST-PROJ').map((record) => record.artifact_id)
    ).toEqual(['ART-PROJ-TMP', 'ART-PROJ-NEW', 'ART-PROJ-OLD']);
    expect(
      listArtifactOwnershipRecordsByQuery({
        projectId: 'PRJ-TEST-PROJ',
        kind: 'markdown',
        includeTmp: false,
      }).map((record) => record.artifact_id)
    ).toEqual(['ART-PROJ-NEW', 'ART-PROJ-OLD']);
    expect(
      findReusableArtifactOwnershipRecord({ projectId: 'PRJ-TEST-PROJ', kind: 'markdown' })
        ?.artifact_id
    ).toBe('ART-PROJ-NEW');
  });

  it('queries current ownership only: a superseded row never matches its old owner', () => {
    const row = (overrides: Record<string, string>) =>
      appendArtifactOwnershipRecord(
        createArtifactOwnershipRecord({
          artifact_id: 'ART-TEST-MOVED',
          kind: 'report',
          storage_class: 'artifact_store',
          ...overrides,
        } as Parameters<typeof createArtifactOwnershipRecord>[0])
      );
    // Published under a mission, then promoted to its project.
    row({ mission_id: 'MSN-TEST-MOVED', path: 'active/missions/public/MSN-TEST-MOVED/a.md' });
    row({
      mission_id: 'MSN-TEST-MOVED',
      project_id: 'PRJ-TEST-MOVED',
      path: 'active/projects/public/shared/PRJ-TEST-MOVED/artifacts/report/a.md',
    });
    appendArtifactOwnershipRecord(
      createArtifactOwnershipRecord({
        artifact_id: 'ART-TEST-OTHER',
        mission_id: 'MSN-TEST-MOVED',
        kind: 'report',
        storage_class: 'artifact_store',
        path: 'active/missions/public/MSN-TEST-MOVED/b.md',
      })
    );

    expect(listArtifactOwnershipRecords()).toHaveLength(3);
    expect(listLatestArtifactOwnershipRecords().map((record) => record.artifact_id)).toEqual([
      'ART-TEST-MOVED',
      'ART-TEST-OTHER',
    ]);
    const forMission = listArtifactOwnershipRecordsForMission('MSN-TEST-MOVED');
    expect(forMission).toHaveLength(2);
    expect(forMission.find((record) => record.artifact_id === 'ART-TEST-MOVED')?.path).toBe(
      'active/projects/public/shared/PRJ-TEST-MOVED/artifacts/report/a.md'
    );
  });

  it('compacts the registry to the latest row per artifact (dry run by default)', () => {
    for (const path of ['a.md', 'b.md', 'c.md']) {
      appendArtifactOwnershipRecord(
        createArtifactOwnershipRecord({
          artifact_id: 'ART-TEST-COMPACT',
          project_id: 'PRJ-TEST',
          kind: 'report',
          storage_class: 'artifact_store',
          path: `active/shared/exports/${path}`,
        })
      );
    }
    expect(compactArtifactOwnershipRegistry()).toEqual({
      total_rows: 3,
      kept_rows: 1,
      removed_rows: 2,
      applied: false,
    });
    expect(listArtifactOwnershipRecords()).toHaveLength(3);

    expect(compactArtifactOwnershipRegistry({ dryRun: false })).toMatchObject({
      removed_rows: 2,
      applied: true,
    });
    expect(listArtifactOwnershipRecords()).toEqual([
      expect.objectContaining({
        artifact_id: 'ART-TEST-COMPACT',
        path: 'active/shared/exports/c.md',
      }),
    ]);
    // Idempotent.
    expect(compactArtifactOwnershipRegistry({ dryRun: false })).toMatchObject({
      removed_rows: 0,
      applied: false,
    });
  });

  it('fails closed on malformed ownership registry JSONL', () => {
    safeWriteFile(registryPath, '{not-json}\n');

    expect(() => listArtifactOwnershipRecords()).toThrow();
  });

  it('rejects schema-invalid ownership records when reading the registry', () => {
    safeWriteFile(
      registryPath,
      `${JSON.stringify({
        artifact_id: 'ART-INVALID-READ',
        kind: 'report',
        storage_class: 'artifact_store',
        created_at: '2026-09-03T00:00:00.000Z',
        evidence_refs: [],
      })}\n`
    );

    expect(() => listArtifactOwnershipRecords()).toThrow(
      /Invalid catalog artifact-ownership-record/
    );
  });

  it('rejects a registry file that traverses a symlink', () => {
    const target = pathResolver.sharedTmp('artifact-ownership-registry-target.jsonl');
    safeWriteFile(target, '{}\n');
    safeSymlinkSync(target, registryPath);

    try {
      expect(() => listArtifactOwnershipRecords()).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(registryPath, { force: true });
      safeRmSync(target, { force: true });
    }
  });

  it('rejects a registry path that is a directory', () => {
    safeMkdir(registryPath, { recursive: true });

    try {
      expect(() => listArtifactOwnershipRecords()).toThrow(
        '[ARTIFACT_REGISTRY] registry must be a regular file'
      );
      expect(() =>
        appendArtifactOwnershipRecord(
          createArtifactOwnershipRecord({
            artifact_id: 'ART-DIRECTORY-REGISTRY',
            project_id: 'PRJ-TEST',
            kind: 'report',
            storage_class: 'artifact_store',
          })
        )
      ).toThrow('[ARTIFACT_REGISTRY] registry must be a regular file');
    } finally {
      safeRmSync(registryPath, { recursive: true, force: true });
    }
  });
});
