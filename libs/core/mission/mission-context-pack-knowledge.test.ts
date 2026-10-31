import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as io from '../secure-io.js';
import * as textIo from '../foundation/text.js';
import { pathResolver } from '../path-resolver.js';
import { knowledgeTextSha256 } from '../knowledge/knowledge-delivery-snapshot.js';
import { withExecutionContextAsync } from '../authority.js';
import { registerJudgmentBackend, resetJudgmentBackends } from '../reasoning/judgment-backend.js';
import {
  loadKnowledgeHintsIfPossible,
  narrowKnowledgeHintsWithJudgment,
} from './mission-context-pack-knowledge.js';

// Isolate discovery and telemetry; the pinned path, leaf read and scope compiler
// remain real. Governed publication provenance is covered by learning integration.
const fixture = vi.hoisted(() => ({ pinned: [] as string[] }));
vi.mock('../knowledge/knowledge-slices.js', () => ({
  resolveKnowledgeSlice: () => ({ pinned: fixture.pinned, exclude: [], searchRoots: [] }),
  isKnowledgePathExcluded: () => false,
  isKnowledgePathInSearchRoots: () => true,
}));
vi.mock('../knowledge/distill-knowledge-injector.js', () => ({
  findRelevantDistilledKnowledge: async () => [],
}));
vi.mock('../organization/tenant-knowledge-retrieval.js', () => ({
  buildTenantKnowledgeScopeSet: () => null,
  queryTenantKnowledgeOutcome: async () => ({ status: 'ready', hits: [] }),
}));
vi.mock('../knowledge/knowledge-verification.js', () => ({
  findChangedSinceVerified: () => [],
  resolveKnowledgeVerification: () => new Map(),
}));
vi.mock('../workforce/worker-event-stream.js', () => ({
  getDefaultWorkerEventStream: () => ({ emit: () => {} }),
}));

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  fixture.pinned = [];
  for (const root of roots.splice(0)) io.safeRmSync(root, { recursive: true, force: true });
  resetJudgmentBackends();
});

function pinFixture() {
  const root = pathResolver.sharedTmp('pinned-ancestor-' + randomUUID());
  roots.push(root);
  const documentPath = 'knowledge/confidential/pinned-fixture/note.md';
  const absolute = path.join(root, documentPath);
  io.safeMkdir(path.dirname(absolute), { recursive: true });
  const text =
    '---\ntitle: Fixed pinned note\n---\n# Fixed pinned note\n\nExact UTF-8 evidence 日本語.\n';
  io.safeWriteFile(absolute, text);
  fixture.pinned = [documentPath];
  const load = () =>
    withExecutionContextAsync(
      'ecosystem_architect',
      () =>
        loadKnowledgeHintsIfPossible({
          missionState: {
            mission_id: 'MSN-PIN-FIXTURE',
            mission_type: 'software',
            tier: 'confidential',
            tenant_slug: 'pinned-fixture',
            status: 'active',
            assigned_persona: 'worker',
            git: {
              branch: 'fixture',
              start_commit: 'fixture',
              latest_commit: 'fixture',
              checkpoints: [],
            },
            history: [],
          },
          teamRole: 'implementer',
          tenantKnowledgeRootDir: root,
        }),
      undefined,
      'pinned-fixture'
    );
  return { root, documentPath, absolute, text, load };
}

describe('pinned knowledge path boundary', () => {
  it('reads the owned scoped leaf without metadata reads on structural ancestors and hashes those same bytes', async () => {
    const f = pinFixture();
    const lstat = io.safeLstat;
    const metadata = vi.spyOn(io, 'safeLstat').mockImplementation((file) => {
      if (String(file) === path.join(f.root, 'knowledge/confidential'))
        throw new Error('Structural prefix has no tenant metadata authority');
      return lstat(file);
    });
    const hints = await f.load();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      path: f.documentPath,
      title: 'Fixed pinned note',
      source_sha256: knowledgeTextSha256(f.text),
    });
    expect(hints[0].excerpt).toContain('Exact UTF-8 evidence 日本語.');
    expect(metadata.mock.calls.some(([file]) => file === f.absolute)).toBe(true);
    expect(
      metadata.mock.calls.some(([file]) => file === path.join(f.root, 'knowledge/confidential'))
    ).toBe(false);
  });

  it.each([
    'missing',
    'not_directory',
    'leaf_symlink',
    'ancestor_symlink',
    'escape',
    'read_failure',
  ] as const)('drops %s pins without reading unsafe bytes', async (kind) => {
    const f = pinFixture();
    if (kind === 'missing') io.safeRmSync(f.absolute);
    if (kind === 'not_directory') {
      io.safeRmSync(path.dirname(f.absolute), { recursive: true, force: true });
      io.safeWriteFile(path.dirname(f.absolute), 'not a directory');
    }
    if (kind === 'leaf_symlink') {
      const original = path.join(f.root, 'original.md');
      io.safeWriteFile(original, f.text);
      io.safeRmSync(f.absolute);
      io.safeSymlinkSync(original, f.absolute);
    }
    if (kind === 'ancestor_symlink') {
      const original = path.join(f.root, 'original');
      io.safeMkdir(original, { recursive: true });
      io.safeWriteFile(path.join(original, 'note.md'), f.text);
      io.safeRmSync(path.dirname(f.absolute), { recursive: true, force: true });
      io.safeSymlinkSync(original, path.dirname(f.absolute), 'dir');
    }
    if (kind === 'escape') fixture.pinned = ['knowledge/confidential/../../package.json'];
    if (kind === 'read_failure') {
      const read = textIo.readTextFile;
      vi.spyOn(textIo, 'readTextFile').mockImplementation((file, options) => {
        if (file === f.absolute) throw new Error('File too large for bounded secure read');
        return read(file, options);
      });
    }
    expect(await f.load()).toEqual([]);
  });
});

describe('narrowKnowledgeHintsWithJudgment', () => {
  it('keeps the pack itself and asks no provider while nothing is calibrated', async () => {
    let asked = 0;
    registerJudgmentBackend({
      judgment_id: 'laya-mlx',
      egress: 'local-only',
      supports: () => true,
      async judge(request) {
        asked += 1;
        return request.questions.map((question) => ({
          id: question.id,
          value: false,
          confidence: 0.99,
          calibrated: false,
        }));
      },
    });
    const hints = [
      { path: 'knowledge/a.md', title: 'A', excerpt: 'alpha', tags: [] },
      { path: 'knowledge/b.md', title: 'B', excerpt: 'beta', tags: [] },
    ];
    const narrowed = await narrowKnowledgeHintsWithJudgment(hints, {
      task: 'repair the login flow',
      tier: 'public',
    });
    expect(narrowed).toBe(hints);
    expect(asked).toBe(0);
  });
});
