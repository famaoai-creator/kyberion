import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./artifact-store.js', () => ({
  writeScopedArtifact: vi.fn(() => ({ repo_relative_path: 'scoped/archive.json' })),
}));
import { writeScopedArtifact } from './artifact-store.js';
import { WorkerContextCompactor, type WorkerContextMessage } from './worker-context-compaction.js';
import {
  CompactionSummaryTimeout,
  runSummaryWithDeadline,
  persistIncompleteHandoff,
} from './worker-compaction-recovery.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('compaction-local recovery', () => {
  it('bounds a stalled provider and ignores late success', async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    let signal!: AbortSignal;
    const result = runSummaryWithDeadline(
      async (s) => {
        signal = s;
        return new Promise<string>((r) => {
          resolve = r;
        });
      },
      { summaryTimeoutMs: 50, summaryIdleTimeoutMs: 10 }
    );
    const rejected = expect(result).rejects.toBeInstanceOf(CompactionSummaryTimeout);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(signal.aborted).toBe(true);
    resolve('late');
    await Promise.resolve();
    expect(writeScopedArtifact).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('progress resets inactivity but never extends the absolute operation deadline', async () => {
    vi.useFakeTimers();
    let progress!: () => void;
    const result = runSummaryWithDeadline(
      async (_, p) => {
        progress = p;
        return new Promise<string>(() => {});
      },
      { summaryTimeoutMs: 25, summaryIdleTimeoutMs: 10 }
    );
    const rejected = expect(result).rejects.toThrow('total');
    await vi.advanceTimersByTimeAsync(8);
    progress();
    await vi.advanceTimersByTimeAsync(8);
    progress();
    await vi.advanceTimersByTimeAsync(8);
    progress();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it('refuses unscoped/conflicting recovery and archives exact context with incomplete status', () => {
    const messages = [{ role: 'user' as const, content: 'unverified prose' }];
    const details = { readFiles: [], modifiedFiles: [] };
    expect(persistIncompleteHandoff(messages, {}, details, undefined)).toBeUndefined();
    expect(
      persistIncompleteHandoff(
        messages,
        {
          scope: { tier: 'confidential', tenant_slug: 'tenant-a', mission_id: 'M1' },
          missionId: 'M2',
        },
        details,
        undefined
      )
    ).toBeUndefined();
    expect(writeScopedArtifact).not.toHaveBeenCalled();
    expect(
      persistIncompleteHandoff(
        messages,
        { scope: { tier: 'confidential', tenant_slug: 'tenant-a', mission_id: 'M1' } },
        details,
        undefined
      )
    ).toBe('scoped/archive.json');
    expect(writeScopedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { mission: 'M1', tenant: 'tenant-a' },
        tier: 'confidential',
        content: expect.objectContaining({ incomplete: true, messages }),
      })
    );
  });

  it('uses a scoped incomplete handoff after repeated stalls and skips the stalled provider thereafter', async () => {
    vi.useFakeTimers();
    const summarize = vi.fn(async () => new Promise<string>(() => {}));
    const messages: WorkerContextMessage[] = [
      { role: 'user', content: 'pinned goal', pinned: true },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: 'user' as const,
        content: `entry ${i} ${'x'.repeat(1000)}`,
      })),
    ];
    const compactor = new WorkerContextCompactor({
      summarize,
      summaryTimeoutMs: 20,
      summaryIdleTimeoutMs: 10,
      scope: { tier: 'public' },
      profile: { contextWindowTokens: 100, reserveTokens: 0, bufferTokens: 0 },
    });
    const first = compactor.maybeCompact(messages);
    await vi.advanceTimersByTimeAsync(10);
    expect((await first).summaryFailureKind).toBe('timeout');
    const second = compactor.maybeCompact(messages);
    await vi.advanceTimersByTimeAsync(10);
    const recovered = await second;
    expect(recovered.stage).toBe('deterministic_handoff');
    expect(recovered.incomplete).toBe(true);
    expect(recovered.messages.some((m) => m.content === 'pinned goal')).toBe(true);
    expect(recovered.messages.some((m) => m.content.includes('not a verified narrative'))).toBe(
      true
    );
    expect((await compactor.maybeCompact(messages)).stage).toBe('deterministic_handoff');
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('fences a superseded summary and its late completion', async () => {
    let resolve!: (summary: string) => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const recordArtifact = vi.fn();
    const messages: WorkerContextMessage[] = Array.from({ length: 12 }, () => ({
      role: 'user',
      content: 'x'.repeat(1000),
    }));
    const compactor = new WorkerContextCompactor({
      profile: { contextWindowTokens: 100, reserveTokens: 0, bufferTokens: 0 },
      summarize: async () => {
        enteredResolve();
        return new Promise<string>((r) => {
          resolve = r;
        });
      },
      recordArtifact,
    });
    const stale = compactor.maybeCompact(messages);
    await entered;
    await compactor.maybeCompact([{ role: 'user', content: 'new generation' }], {
      summarize: undefined,
      force: false,
    });
    expect((await stale).compacted).toBe(false);
    resolve('late summary');
    await Promise.resolve();
    expect(recordArtifact).not.toHaveBeenCalled();
    expect(writeScopedArtifact).not.toHaveBeenCalled();
  });

  it('retains history when scoped recovery storage fails', async () => {
    vi.mocked(writeScopedArtifact).mockImplementationOnce(() => {
      throw new Error('unavailable');
    });
    const messages: WorkerContextMessage[] = Array.from({ length: 12 }, () => ({
      role: 'user',
      content: 'x'.repeat(1000),
    }));
    const compactor = new WorkerContextCompactor({
      profile: { contextWindowTokens: 100, reserveTokens: 0, bufferTokens: 0 },
      scope: { tier: 'public' },
      forceDeterministicHandoff: true,
    });
    const result = await compactor.maybeCompact(messages);
    expect(result.stage).toBe('microcompact');
    expect(result.messages).toEqual(messages);
    expect(result.incomplete).not.toBe(true);
  });
});
