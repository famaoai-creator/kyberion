import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeReadFileSnapshot,
  safeWriteFile,
} from '../secure-io.js';
import {
  createArtifactRecord,
  loadArtifactRecord,
  saveArtifactRecord,
} from '../workforce/artifact-record.js';
import { appendDiscussionEvent, readDiscussionRoom } from './discussion-store.js';
import { reduceDiscussionRoom } from './discussion-reducer.js';
import {
  publishDiscussionOutcomes,
  refreshDiscussionDeliverables,
  readSavedDiscussionArtifact,
  MAX_SAVED_DISCUSSION_ARTIFACT_BYTES,
} from './discussion-outcomes.js';

vi.mock('../secure-io.js', async (original) => ({
  ...(await original<typeof import('../secure-io.js')>()),
  safeWriteFile: vi.fn(),
  safeLstat: vi.fn(),
  safeReadFileSnapshot: vi.fn(),
  assertSafeRepositoryPath: vi.fn((file) => file),
}));
vi.mock('../workforce/artifact-record.js', () => ({
  createArtifactRecord: vi.fn((input) => ({ ...input, artifact_id: 'ART-' + input.kind })),
  saveArtifactRecord: vi.fn(),
  loadArtifactRecord: vi.fn(),
}));
vi.mock('../workforce/work-coordination.js', () => ({ createWorkItem: vi.fn() }));
vi.mock('./discussion-store.js', async (original) => ({
  ...(await original<typeof import('./discussion-store.js')>()),
  readDiscussionRoom: vi.fn(),
  appendDiscussionEvent: vi.fn(),
}));

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertSafeRepositoryPath).mockImplementation((file) => file);
  vi.mocked(safeLstat).mockReturnValue({
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 10,
  } as ReturnType<typeof safeLstat>);
  const room = reduceDiscussionRoom('disc-saved-test', []);
  room.title = 'Saved evidence';
  room.goal = 'Preserve exactly what was generated';
  room.config.locale = 'en';
  room.scope = { tenant_slug: 'tenant-a', organization_id: 'org-a', project_id: 'project-a' };
  room.decision = {
    type: 'decision',
    seq: 1,
    ts: '2026-10-18T00:00:00Z',
    summary: 'Persist the result',
    agreements: [],
    dissent: [],
    next_steps: [],
    consensus: 1,
    concluded_by: 'facilitator',
  };
  vi.mocked(readDiscussionRoom).mockReturnValue(room);
});

describe('saved discussion artifacts', () => {
  it('persists the digest and byte count of each exact saved file', () => {
    publishDiscussionOutcomes('disc-saved-test');
    expect(createArtifactRecord).toHaveBeenCalledTimes(2);
    expect(saveArtifactRecord).toHaveBeenCalledTimes(2);
    for (const [record] of vi.mocked(saveArtifactRecord).mock.calls) {
      const write = vi
        .mocked(safeWriteFile)
        .mock.calls.find(([file]) => String(file).endsWith(record.path!));
      expect(write).toBeDefined();
      const bytes = Buffer.from(write![1]);
      expect(record.metadata?.content_sha256).toBe(digest(bytes));
      expect(record.metadata?.content_bytes).toBe(bytes.length);
    }
  });
});

function published() {
  const room =
    vi.mocked(readDiscussionRoom).mock.results.at(-1)?.value ??
    readDiscussionRoom('disc-saved-test')!;
  publishDiscussionOutcomes(room.id);
  const records = vi.mocked(saveArtifactRecord).mock.calls.map(([record]) => record);
  const minutes = records.find((record) => record.kind === 'markdown')!;
  const brief = records.find((record) => record.kind === 'html')!;
  room.outcomes.minutes = {
    artifact_id: minutes.artifact_id,
    kind: minutes.kind,
    path: minutes.path!,
  };
  room.outcomes.brief = { artifact_id: brief.artifact_id, path: brief.path! };
  vi.mocked(loadArtifactRecord).mockImplementation(
    (id) => records.find((record) => record.artifact_id === id) ?? null
  );
  vi.mocked(safeReadFileSnapshot).mockImplementation((file) => {
    const write = vi.mocked(safeWriteFile).mock.calls.find(([target]) => target === file)!;
    return Buffer.from(write[1]);
  });
  return { room, minutes, brief, records };
}

describe('room-bound saved artifact reader', () => {
  it('returns precisely the persisted bytes with verified hashes for both formats', () => {
    const { room, records } = published();
    for (const record of records) {
      const file = readSavedDiscussionArtifact(room, record.artifact_id)!;
      expect(file.sha256).toBe(record.metadata?.content_sha256);
      expect(digest(file.bytes)).toBe(file.sha256);
      expect(file.bytes.length).toBe(record.metadata?.content_bytes);
    }
    expect(safeReadFileSnapshot).toHaveBeenCalledWith(
      expect.any(String),
      MAX_SAVED_DISCUSSION_ARTIFACT_BYTES
    );
  });

  it.each([
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'artifact_id',
    'path',
    'kind',
    'storage_class',
  ] as const)('rejects mismatched record %s before probing file existence', (field) => {
    const { room, minutes } = published();
    Object.assign(minutes, { [field]: 'other' });
    expect(readSavedDiscussionArtifact(room, room.outcomes.minutes!.artifact_id)).toBeNull();
    expect(safeLstat).not.toHaveBeenCalled();
    expect(safeReadFileSnapshot).not.toHaveBeenCalled();
  });

  it.each(['discussion_id', 'tier', 'source'] as const)(
    'rejects mismatched ownership metadata %s',
    (field) => {
      const { room, minutes } = published();
      minutes.metadata![field] = 'other';
      expect(readSavedDiscussionArtifact(room, minutes.artifact_id)).toBeNull();
      expect(safeLstat).not.toHaveBeenCalled();
    }
  );

  it('rejects same-tenant cross-room IDs and stale room references', () => {
    const { room, minutes } = published();
    const other = { ...room, id: 'disc-other-room' };
    expect(readSavedDiscussionArtifact(other, minutes.artifact_id)).toBeNull();
    expect(readSavedDiscussionArtifact(room, 'ART-elsewhere')).toBeNull();
    room.outcomes.minutes!.path = 'active/shared/runtime/discussions/disc-other-room/minutes.md';
    expect(readSavedDiscussionArtifact(room, minutes.artifact_id)).toBeNull();
    expect(safeLstat).not.toHaveBeenCalled();
  });

  it('rejects path traversal IDs, duplicate IDs, and missing records', () => {
    const { room, minutes } = published();
    for (const id of ['..', '.', '../ART-other', 'ART%2fother', ' ART-markdown', 'x'.repeat(161)]) {
      expect(readSavedDiscussionArtifact(room, id)).toBeNull();
    }
    expect(readSavedDiscussionArtifact({ ...room, id: '..' }, minutes.artifact_id)).toBeNull();
    room.outcomes.brief!.artifact_id = minutes.artifact_id;
    expect(readSavedDiscussionArtifact(room, minutes.artifact_id)).toBeNull();
    room.outcomes.brief = null;
    vi.mocked(loadArtifactRecord).mockReturnValue(null);
    expect(readSavedDiscussionArtifact(room, minutes.artifact_id)).toBeNull();
    expect(safeLstat).not.toHaveBeenCalled();
  });

  it('fails closed for legacy bytes with no evidence and malformed evidence', () => {
    const { room, minutes } = published();
    delete minutes.metadata!.content_sha256;
    delete minutes.metadata!.content_bytes;
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(
      /no integrity evidence/u
    );
    minutes.metadata!.content_sha256 = 'bad';
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(
      /evidence is invalid/u
    );
    expect(safeLstat).not.toHaveBeenCalled();
  });

  it('rejects oversized metadata/files without reading and rejects tampering', () => {
    const { room, minutes } = published();
    const length = minutes.metadata!.content_bytes;
    minutes.metadata!.content_bytes = MAX_SAVED_DISCUSSION_ARTIFACT_BYTES + 1;
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(/size limit/u);
    expect(safeLstat).not.toHaveBeenCalled();
    minutes.metadata!.content_bytes = length;
    vi.mocked(safeLstat).mockReturnValueOnce({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: MAX_SAVED_DISCUSSION_ARTIFACT_BYTES + 1,
    } as ReturnType<typeof safeLstat>);
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(/size limit/u);
    expect(safeReadFileSnapshot).not.toHaveBeenCalled();
    vi.mocked(safeReadFileSnapshot).mockReturnValueOnce(Buffer.from('tampered'));
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(/differs/u);
  });

  it('rejects symlink targets/components and non-regular files', () => {
    const { room, minutes } = published();
    vi.mocked(assertSafeRepositoryPath).mockImplementationOnce(() => {
      throw new Error('symlink component');
    });
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(/read safely/u);
    expect(safeLstat).not.toHaveBeenCalled();
    vi.mocked(safeLstat).mockReturnValueOnce({
      isFile: () => true,
      isSymbolicLink: () => true,
      size: 10,
    } as ReturnType<typeof safeLstat>);
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(
      /safe regular file/u
    );
    vi.mocked(safeLstat).mockReturnValueOnce({
      isFile: () => false,
      isSymbolicLink: () => false,
      size: 10,
    } as ReturnType<typeof safeLstat>);
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(
      /safe regular file/u
    );
    expect(safeReadFileSnapshot).not.toHaveBeenCalled();
  });

  it('does not substitute generated bytes for a missing or changed file', () => {
    const { room, minutes } = published();
    vi.mocked(assertSafeRepositoryPath).mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect(readSavedDiscussionArtifact(room, minutes.artifact_id)).toBeNull();
    vi.mocked(safeReadFileSnapshot).mockImplementationOnce(() => {
      throw new Error('inode changed');
    });
    expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(/read safely/u);
  });

  it('refreshes the digest after review while keeping both artifact identities', () => {
    const { room, records } = published();
    const original = records.map((record) => ({
      id: record.artifact_id,
      hash: record.metadata!.content_sha256,
    }));
    room.title = 'Reviewed title';
    room.outcomes.review = { verdict: 'accept', actor: 'reviewer', ts: '2026-10-18T01:00:00Z' };
    vi.mocked(safeWriteFile).mockClear();
    vi.mocked(saveArtifactRecord).mockClear();
    refreshDiscussionDeliverables(room.id);
    const refreshed = vi.mocked(saveArtifactRecord).mock.calls.map(([record]) => record);
    expect(refreshed.map((record) => record.artifact_id)).toEqual(
      original.map((record) => record.id)
    );
    for (let i = 0; i < refreshed.length; i++) {
      expect(refreshed[i].metadata!.content_sha256).not.toBe(original[i].hash);
      const write = vi.mocked(safeWriteFile).mock.calls[i];
      expect(refreshed[i].metadata!.content_sha256).toBe(digest(write[1]));
    }
  });
});

describe('saved artifact publication failure truth', () => {
  const safeMessage =
    'Decision generated but saved artifact publication failed; no model retry performed.';
  it.each(['write', 'record'] as const)(
    'persists a safe failed event after a %s failure',
    (stage) => {
      const failure = () => {
        throw new Error('/private/secret raw filesystem error');
      };
      if (stage === 'write') vi.mocked(safeWriteFile).mockImplementationOnce(failure);
      else vi.mocked(saveArtifactRecord).mockImplementationOnce(failure);
      publishDiscussionOutcomes('disc-saved-test');
      expect(appendDiscussionEvent).toHaveBeenLastCalledWith('disc-saved-test', {
        type: 'error',
        message: safeMessage,
      });
      const body = vi.mocked(appendDiscussionEvent).mock.calls.at(-1)![1];
      const failed = reduceDiscussionRoom('disc-saved-test', [
        { ...body, seq: 1, ts: '2026-10-18T00:00:00Z' },
      ]);
      expect(failed.status).toBe('failed');
      expect(failed.error).not.toContain('secret');
    }
  );

  it('does not claim both outputs succeeded when minutes saved but brief failed', () => {
    vi.mocked(safeWriteFile)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('brief unavailable');
      });
    publishDiscussionOutcomes('disc-saved-test');
    expect(saveArtifactRecord).toHaveBeenCalledTimes(1);
    expect(appendDiscussionEvent).toHaveBeenCalledWith(
      'disc-saved-test',
      expect.objectContaining({ type: 'minutes_published' })
    );
    expect(appendDiscussionEvent).not.toHaveBeenCalledWith(
      'disc-saved-test',
      expect.objectContaining({ type: 'brief_published' })
    );
    expect(appendDiscussionEvent).toHaveBeenLastCalledWith('disc-saved-test', {
      type: 'error',
      message: safeMessage,
    });
  });

  it('marks refresh failure without rebinding an invalid artifact or rerunning generation', () => {
    const { room, minutes } = published();
    minutes.metadata!.discussion_id = 'other-room';
    vi.mocked(safeWriteFile).mockClear();
    vi.mocked(saveArtifactRecord).mockClear();
    refreshDiscussionDeliverables(room.id);
    expect(safeWriteFile).not.toHaveBeenCalled();
    expect(saveArtifactRecord).not.toHaveBeenCalled();
    expect(appendDiscussionEvent).toHaveBeenLastCalledWith(room.id, {
      type: 'error',
      message: safeMessage,
    });
  });
});

it('rejects refreshed bytes if updating their artifact record fails', () => {
  const { room, minutes } = published();
  const originalDigest = minutes.metadata!.content_sha256;
  room.title = 'Changed after human review';
  vi.mocked(safeWriteFile).mockClear();
  vi.mocked(saveArtifactRecord).mockImplementationOnce(() => {
    throw new Error('record persistence unavailable');
  });
  refreshDiscussionDeliverables(room.id);
  expect(safeWriteFile).toHaveBeenCalledTimes(1);
  expect(minutes.metadata!.content_sha256).toBe(originalDigest);
  expect(appendDiscussionEvent).toHaveBeenLastCalledWith(room.id, {
    type: 'error',
    message: 'Decision generated but saved artifact publication failed; no model retry performed.',
  });
  expect(() => readSavedDiscussionArtifact(room, minutes.artifact_id)).toThrow(/differs/u);
});
