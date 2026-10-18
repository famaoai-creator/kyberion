import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeUnlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { loadArtifactRecord } from '../workforce/artifact-record.js';
import { reduceDiscussionRoom } from './discussion-reducer.js';
import {
  MAX_SAVED_DISCUSSION_ARTIFACT_BYTES,
  readSavedDiscussionArtifact,
} from './discussion-outcomes.js';

vi.mock('../workforce/artifact-record.js', () => ({
  loadArtifactRecord: vi.fn(),
  createArtifactRecord: vi.fn(),
  saveArtifactRecord: vi.fn(),
}));
vi.mock('../workforce/work-coordination.js', () => ({ createWorkItem: vi.fn() }));
const room = reduceDiscussionRoom('disc-real-io', []);
const logical = 'active/shared/runtime/discussions/disc-real-io/minutes.md';
const bytes = Buffer.from('# Exact saved evidence\n');
const scope = {
  tenant_slug: 'tenant-fixture',
  organization_id: 'org-fixture',
  project_id: 'project-fixture',
};
let root: string;
let target: string;
const run = <T>(fn: () => T) => withExecutionContext('ecosystem_architect', fn);

beforeEach(() => {
  root = pathResolver.rootResolve('active/shared/tmp/discussion-saved-io-' + randomUUID());
  target = root + '/room/minutes.md';
  room.scope = scope;
  room.outcomes.minutes = { artifact_id: 'ART-IO', kind: 'markdown', path: logical };
  vi.mocked(loadArtifactRecord).mockReturnValue({
    artifact_id: 'ART-IO',
    ...scope,
    kind: 'markdown',
    storage_class: 'repo',
    path: logical,
    metadata: {
      source: 'discussion_room',
      discussion_id: room.id,
      tier: 'confidential',
      content_bytes: bytes.length,
      content_sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
  run(() => safeWriteFile(target, bytes));
  const original = pathResolver.rootResolve.bind(pathResolver);
  vi.spyOn(pathResolver, 'rootResolve').mockImplementation((...parts: string[]) =>
    parts.length === 1 && parts[0] === logical ? target : original(...parts)
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  run(() => safeRmSync(root, { recursive: true, force: true }));
});

describe('saved artifact secure filesystem boundary', () => {
  it('reads the real persisted snapshot and rejects changed bytes', () =>
    run(() => {
      expect(readSavedDiscussionArtifact(room, 'ART-IO')?.bytes).toEqual(bytes);
      safeWriteFile(target, 'tampered');
      expect(() => readSavedDiscussionArtifact(room, 'ART-IO')).toThrow(/differs/u);
    }));

  it('rejects a real symlink leaf pointing to another file', () =>
    run(() => {
      const other = root + '/other.md';
      safeWriteFile(other, bytes);
      safeUnlinkSync(target);
      safeSymlinkSync(other, target, 'file');
      expect(() => readSavedDiscussionArtifact(room, 'ART-IO')).toThrow(/read safely/u);
      safeUnlinkSync(target);
    }));

  it('rejects a real symlink path component even within the repository', () =>
    run(() => {
      const other = root + '/other';
      safeWriteFile(other + '/minutes.md', bytes);
      safeRmSync(root + '/room', { recursive: true });
      safeSymlinkSync(other, root + '/room', 'dir');
      expect(() => readSavedDiscussionArtifact(room, 'ART-IO')).toThrow(/read safely/u);
      safeUnlinkSync(root + '/room');
    }));

  it('rejects an oversized real file and a directory target', () =>
    run(() => {
      safeWriteFile(target, Buffer.alloc(MAX_SAVED_DISCUSSION_ARTIFACT_BYTES + 1));
      expect(() => readSavedDiscussionArtifact(room, 'ART-IO')).toThrow(/size limit/u);
      safeUnlinkSync(target);
      safeMkdir(target);
      expect(() => readSavedDiscussionArtifact(room, 'ART-IO')).toThrow(/safe regular file/u);
    }));
});
