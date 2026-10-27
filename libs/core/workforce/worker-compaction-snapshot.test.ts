import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WriteScopedArtifactInput, ScopedArtifactScope } from './artifact-store.js';
// The shared lock protocol has its own filesystem tests; isolate its global directory here.
vi.mock('../foundation/lock-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../foundation/lock-utils.js')>()),
  withLockSync: (_key: string, run: () => unknown) => run(),
}));
const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  rows: [] as Array<Record<string, unknown>>,
  deleted: [] as string[],
}));
vi.mock('./artifact-store.js', () => ({
  writeScopedArtifact: vi.fn((input: WriteScopedArtifactInput) => {
    const file = `active/shared/tmp/snapshot-test/${input.name}`;
    if (fixture.files.has(file)) throw new Error('immutable');
    fixture.files.set(file, String(input.content));
    fixture.rows.push({
      path: file,
      name: input.name,
      artifact_class: input.artifact_class,
      scope: input.scope,
      tier: input.tier,
    });
    return { repo_relative_path: file };
  }),
  readScopedArtifactIndex: vi.fn((scope: ScopedArtifactScope, tier?: string) =>
    fixture.rows.filter(
      (row) => JSON.stringify(row.scope) === JSON.stringify(scope) && row.tier === tier
    )
  ),
}));
vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return {
    ...actual,
    assertSafeRepositoryPath: (file: string, options?: { allowMissingLeaf?: boolean }) =>
      fixture.files.has(file) ? file : actual.assertSafeRepositoryPath(file, options),
    safeReadFileSnapshot: vi.fn((file: string, max: number) => {
      const key = [...fixture.files.keys()].find((key) => file.endsWith(key));
      return key ? Buffer.from(fixture.files.get(key)!) : actual.safeReadFileSnapshot(file, max);
    }),
    safeUnlinkSync: vi.fn((file: string) => {
      const key = [...fixture.files.keys()].find((key) => file.endsWith(key));
      if (key) {
        fixture.files.delete(key);
        fixture.deleted.push(key);
      } else actual.safeUnlinkSync(file);
    }),
  };
});
import { safeRmSync, safeReadFileSnapshot, safeUnlinkSync } from '../secure-io.js';
import { writeScopedArtifact } from './artifact-store.js';
import { WorkerStateJournal, WORKER_STATE_OPS, runInRestoreMode } from './worker-state-journal.js';
import { compactWorkerContext, type WorkerContextMessage } from './worker-context-compaction.js';
import {
  readCompactionSnapshot,
  writeCompactionSnapshot,
  restoreJournalCompaction,
  purgeJournalCompactions,
} from './worker-compaction-snapshot.js';
const root = `active/shared/tmp/compaction-snapshot-test-${randomUUID()}`;
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'snapshot-tenant',
  mission_id: 'SNAPSHOT-M1',
  task_id: 'T1',
};
const messages: WorkerContextMessage[] = [
  { role: 'user', content: 'goal', pinned: true },
  ...Array.from({ length: 10 }, (_, index) => ({
    role: 'tool_result' as const,
    content: `${index} ${'x'.repeat(1000)}`,
  })),
];
afterEach(() => {
  fixture.files.clear();
  fixture.rows.length = 0;
  fixture.deleted.length = 0;
  vi.clearAllMocks();
  safeRmSync(root, { recursive: true, force: true });
});
const journal = () => new WorkerStateJournal({ journalPath: `${root}/journal.jsonl` });

describe('durable compaction and scoped snapshot recovery', () => {
  it('surfaces cleanup failure rather than reporting a normal missing checkpoint', async () => {
    vi.mocked(safeReadFileSnapshot).mockImplementationOnce(() => {
      throw new Error('transient read failure');
    });
    vi.mocked(safeUnlinkSync).mockImplementationOnce(() => {
      throw new Error('unlink unavailable');
    });
    const result = await compactWorkerContext(messages, {
      force: true,
      scope,
      durability: { journal: journal() },
    });
    expect(result.messages).toEqual(messages);
    expect(result.durabilityError).toBe('checkpoint_cleanup_required');
    expect(journal().compactionTip(scope)).toBeUndefined();
  });
  it('rolls back newly written raw context if post-write verification fails', async () => {
    vi.mocked(safeReadFileSnapshot).mockImplementationOnce(() => {
      throw new Error('transient read failure');
    });
    const result = await compactWorkerContext(messages, {
      force: true,
      scope,
      durability: { journal: journal() },
    });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(fixture.files.size).toBe(0);
    expect(fixture.deleted).toHaveLength(1);
    expect(journal().compactionTip(scope)).toBeUndefined();
  });
  it('requires immutable raw-history receipt before replacing context and restores without executing tools', async () => {
    const result = await compactWorkerContext(messages, {
      force: true,
      scope,
      missionId: scope.mission_id,
      taskId: scope.task_id,
      keepRecentToolResults: 1,
      durability: { journal: journal(), retentionMs: 1000, now: () => 100 },
    });
    expect(result.compacted).toBe(true);
    expect(result.snapshotReceipt?.generation).toBe(1);
    expect(writeScopedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        create_only: true,
        tier: 'confidential',
        scope: { mission: scope.mission_id, task: scope.task_id, tenant: scope.tenant_slug },
      })
    );
    const restored = await restoreJournalCompaction(journal(), scope, 101);
    expect(restored?.messages).toEqual(result.messages);
    expect(
      journal().restore().compactionSnapshots?.[result.snapshotReceipt!.scopeKey]
    ).toHaveLength(1);
    const raw = JSON.parse(fixture.files.get(result.snapshotReceipt!.artifactPath)!);
    expect(raw.source).toEqual(messages);
    expect(raw.expiresAt).toBe(1100);
  });

  it('retains exact history and no committed receipt on storage failure', async () => {
    vi.mocked(writeScopedArtifact).mockImplementationOnce(() => {
      throw new Error('private storage detail');
    });
    const result = await compactWorkerContext(messages, {
      force: true,
      scope,
      durability: { journal: journal() },
    });
    expect(result.messages).toEqual(messages);
    expect(result.compacted).toBe(false);
    expect(result.durabilityError).toBe('checkpoint_unavailable');
    expect(journal().compactionTip(scope)).toBeUndefined();
  });

  it('rejects scope mismatch, altered content and expired snapshots; restore never deletes', async () => {
    const receipt = await writeCompactionSnapshot({
      source: messages,
      messages,
      scope,
      retentionMs: 100,
      now: 100,
    });
    await expect(
      readCompactionSnapshot({ ...receipt, generation: receipt.generation + 1 }, scope, 101)
    ).rejects.toThrow('content mismatch');
    await expect(
      readCompactionSnapshot({ ...receipt, parentId: randomUUID() }, scope, 101)
    ).rejects.toThrow('content mismatch');
    await expect(
      readCompactionSnapshot(receipt, { ...scope, tenant_slug: 'another-tenant' }, 101)
    ).rejects.toThrow('scope mismatch');
    await expect(readCompactionSnapshot(receipt, scope, 200)).rejects.toThrow('expired');
    expect(fixture.deleted).toEqual([]);
    fixture.files.set(receipt.artifactPath, '{}');
    await expect(readCompactionSnapshot(receipt, scope, 101)).rejects.toThrow('digest changed');
  });

  it('rejects stale parents and ambiguous replay, while valid chains select the newest tip', async () => {
    const first = await writeCompactionSnapshot({ source: messages, messages, scope, now: 100 });
    journal().recordCompaction(first);
    const second = await writeCompactionSnapshot({
      source: messages,
      messages,
      scope,
      parent: first,
      now: 101,
    });
    journal().recordCompaction(second);
    const competing = await writeCompactionSnapshot({
      source: messages,
      messages,
      scope,
      parent: first,
      now: 102,
    });
    expect(() => journal().recordCompaction(competing)).toThrow('Stale');
    expect((await restoreJournalCompaction(journal(), scope, 103))?.receipt.id).toBe(second.id);
    journal().append(WORKER_STATE_OPS.compactionCommit, competing);
    expect(() => journal().restore()).toThrow('Ambiguous');
  });

  it('purges only expired same-scope hash-verified artifacts through explicit maintenance', async () => {
    const receipt = await writeCompactionSnapshot({
      source: messages,
      messages,
      scope,
      retentionMs: 100,
      now: 100,
    });
    const store = journal();
    store.recordCompaction(receipt);
    expect(await purgeJournalCompactions(store, scope, 199)).toBe(0);
    expect(await purgeJournalCompactions(store, scope, 200)).toBe(1);
    expect(fixture.deleted).toEqual([receipt.artifactPath]);
    expect(() => runInRestoreMode(() => store.recordCompaction(receipt))).toThrow('forbidden');
  });
});
