import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerContextMessage } from '../workforce/worker-context-compaction.js';
const mocks = vi.hoisted(() => ({ compact: vi.fn(), constructJournal: vi.fn(), restore: vi.fn() }));
vi.mock('../workforce/worker-compaction-snapshot.js', async (original) => ({
  ...(await original<typeof import('../workforce/worker-compaction-snapshot.js')>()),
  restoreJournalCompaction: mocks.restore,
}));
vi.mock('../owner-scope.js', async (original) => ({
  ...(await original<typeof import('../owner-scope.js')>()),
  resolveMissionDir: () => 'active/shared/tmp/vitest-mission-compaction-caller',
}));
vi.mock('../workforce/worker-context-compaction.js', async (original) => ({
  ...(await original<typeof import('../workforce/worker-context-compaction.js')>()),
  WorkerContextCompactor: class {
    maybeCompact = mocks.compact;
  },
}));
vi.mock('../workforce/worker-state-journal.js', async (original) => ({
  ...(await original<typeof import('../workforce/worker-state-journal.js')>()),
  WorkerStateJournal: vi.fn(function (options: { journalPath: string }) {
    mocks.constructJournal(options);
    return {};
  }),
}));
import { safeMkdir, safeRmSync } from '../secure-io.js';
import {
  dispatchCompactors,
  maybeCompactDispatchSections,
} from './mission-orchestration-worker-part-context.js';
const root = 'active/shared/tmp/vitest-mission-compaction-caller';
const input = () => ({
  missionId: 'MSN-SNAPSHOT',
  task: { task_id: 'T1', compaction_durability: { retention_ms: 1000, restore: true } },
  allTasks: [],
  agentId: 'agent-a',
  missionContextPackText: 'current pack',
  missionGoalLines: ['current goal'],
  upstreamResultLines: ['current upstream'],
  teamSnapshotLines: ['current team'],
  securityScope: {
    write_tier: 'confidential' as const,
    read_tiers: ['public' as const, 'confidential' as const],
    tenant_id: 'tenant-x',
    tenant_slug: 'tenant-x',
    mission_id: 'MSN-SNAPSHOT',
    purpose: 'fixture',
  },
});
beforeEach(() => {
  safeMkdir(root, { recursive: true });
  dispatchCompactors.clear();
  vi.clearAllMocks();
  mocks.restore.mockResolvedValue(null);
  mocks.compact.mockImplementation(async (messages: WorkerContextMessage[]) => ({
    messages,
    compacted: false,
    stage: 'none',
    tokensBefore: 1,
    tokensAfter: 1,
    thresholdTokens: 100,
    retainedTail: [],
    details: { readFiles: [], modifiedFiles: [] },
  }));
});
afterEach(() => {
  dispatchCompactors.clear();
  safeRmSync(root, { recursive: true, force: true });
});
describe('mission compaction durability production composition', () => {
  it('does not share first-restore admission or failure state across same-id tenant tasks', async () => {
    const alpha = input();
    const beta = {
      ...input(),
      securityScope: { ...input().securityScope, tenant_id: 'tenant-y', tenant_slug: 'tenant-y' },
    };
    await maybeCompactDispatchSections(alpha);
    await maybeCompactDispatchSections(beta);
    expect(mocks.restore).toHaveBeenCalledTimes(2);
    expect(dispatchCompactors.size).toBe(2);
  });
  it('also fences legacy summary-tail and stalled raw archives without changing current input scope', async () => {
    const request = input();
    const securityScope = {
      ...request.securityScope,
      write_tier: 'public' as const,
      read_tiers: ['public' as const, 'confidential' as const],
    };
    const legacy = { ...request, task: { task_id: 'T1' }, securityScope };
    expect(await maybeCompactDispatchSections(legacy)).toEqual({
      upstreamResultLines: request.upstreamResultLines,
      teamSnapshotLines: request.teamSnapshotLines,
    });
    await expect(maybeCompactDispatchSections({ ...legacy, force: true })).rejects.toThrow(
      'COMPACTION_SCOPE_NEEDS_ATTENTION'
    );
    expect(mocks.compact).not.toHaveBeenCalled();
    expect(mocks.constructJournal).not.toHaveBeenCalled();
  });
  it('refuses lower-tier raw retention before any compaction or journal creation', async () => {
    for (const readTier of ['confidential', 'personal'] as const) {
      const request = input();
      const upstream = [...request.upstreamResultLines];
      const securityScope = {
        ...request.securityScope,
        write_tier: 'public' as const,
        read_tiers: ['public' as const, readTier],
      };
      await expect(maybeCompactDispatchSections({ ...request, securityScope })).rejects.toThrow(
        'COMPACTION_SCOPE_NEEDS_ATTENTION'
      );
      expect(request.upstreamResultLines).toEqual(upstream);
    }
    expect(mocks.compact).not.toHaveBeenCalled();
    expect(mocks.constructJournal).not.toHaveBeenCalled();
  });
  it('connects owner-authored task policy to the existing per-task journal and canonical scope', async () => {
    await maybeCompactDispatchSections(input());
    expect(mocks.constructJournal).toHaveBeenCalledWith({
      journalPath: expect.stringContaining('/coordination/goal-journal-T1.jsonl'),
    });
    expect(mocks.compact).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        durability: { journal: expect.any(Object), retentionMs: 1000 },
        scope: expect.objectContaining({
          tenant_slug: 'tenant-x',
          mission_id: 'MSN-SNAPSHOT',
          task_id: 'T1',
        }),
      })
    );
  });
  it('restores once, preserves current pinned context and does not silently bypass a failed restore', async () => {
    mocks.restore.mockResolvedValue({
      messages: [
        { role: 'user', content: 'old pinned instruction', pinned: true },
        { role: 'user', content: 'historical context' },
      ],
    });
    const restored = await maybeCompactDispatchSections(input());
    expect(restored.upstreamResultLines.join('\n')).toContain('historical context');
    expect(JSON.stringify(mocks.compact.mock.calls[0][0])).not.toContain('old pinned instruction');
    expect(JSON.stringify(mocks.compact.mock.calls[0][0])).toContain('current goal');
    await maybeCompactDispatchSections(input());
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    dispatchCompactors.clear();
    mocks.restore.mockRejectedValue(new Error('private stale path'));
    await expect(maybeCompactDispatchSections(input())).rejects.toThrow('RECOVERY_NEEDS_ATTENTION');
    await expect(maybeCompactDispatchSections(input())).rejects.toThrow('RECOVERY_NEEDS_ATTENTION');
  });
});
