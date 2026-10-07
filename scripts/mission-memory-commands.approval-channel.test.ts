import { beforeEach, describe, expect, it, vi } from 'vitest';

// KL-04: the approve verb's channel handling, isolated from review/audit
// machinery (covered by the queue and review suites).
const updateStatus = vi.fn();
vi.mock('@agent/core/knowledge/memory-promotion-review', () => ({
  reviewMemoryPromotionCandidate: () => [
    {
      candidate_id: 'MEM-KL04-CLI',
      blockers: [],
      candidate: {
        candidate_id: 'MEM-KL04-CLI',
        source_type: 'artifact',
        knowledge_domain: 'product',
        sensitivity_tier: 'public',
      },
    },
  ],
  reviewMemoryPromotionQueue: () => [],
  assertMemoryPromotionReviewReady: () => undefined,
}));
const queueRows = vi.fn((): unknown[] => []);
vi.mock('@agent/core/knowledge/memory-promotion-queue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateMemoryPromotionCandidateStatus: (input: unknown) => {
    updateStatus(input);
    return { candidate_id: 'MEM-KL04-CLI' };
  },
  listMemoryPromotionCandidates: () => queueRows(),
}));
const promoteCandidate = vi.fn(async (input: { candidateId: string; targetRoot?: string }) => ({
  candidate: { candidate_id: input.candidateId },
  promotedRef: `knowledge/product/evolution/wisdom/generated/${input.candidateId}.md`,
  ...(input.targetRoot ? { targetRoot: input.targetRoot } : {}),
}));
vi.mock('@agent/core/knowledge/memory-promotion-workflow', () => ({
  promoteMemoryCandidateToKnowledge: (input: { candidateId: string; targetRoot?: string }) =>
    promoteCandidate(input),
  promotePersonalMemoryCandidates: async () => ({
    enabled: false,
    considered: 0,
    promoted: [],
    skipped: [],
  }),
}));
vi.mock('@agent/core/knowledge/memory-promotion-git', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePromotionTargetRoot: (root: string) => ({ root, sameAsCurrent: false }),
}));

import {
  approveMemoryCandidate,
  promotePendingMemoryCandidates,
} from './refactor/mission-memory-commands.js';
import { ScriptExitError } from './lib/harness.js';

describe('memory-approve --approval-channel (KL-04)', () => {
  beforeEach(() => updateStatus.mockClear());

  it('defaults to the steward channel', () => {
    approveMemoryCandidate('MEM-KL04-CLI');
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvalChannel: 'steward' })
    );
  });

  it('persists pr_review when requested', () => {
    approveMemoryCandidate(
      'MEM-KL04-CLI',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'pr_review'
    );
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ approvalChannel: 'pr_review' })
    );
  });

  it('rejects unknown channels before touching the queue', () => {
    expect(() =>
      approveMemoryCandidate(
        'MEM-KL04-CLI',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'merge_bot'
      )
    ).toThrowError(ScriptExitError);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('lists every missing curation property in one error (no error-driven loop)', () => {
    expect(() =>
      approveMemoryCandidate(
        'MEM-KL04-CLI',
        undefined,
        undefined,
        undefined,
        undefined,
        JSON.stringify({ title: 'only title' })
      )
    ).toThrowError(/summary.*content.*evidence_refs/s);
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe('memory-promote-pending --mission / --target-root (KL-05)', () => {
  const row = (candidateId: string, sourceRef: string, extra: Record<string, unknown> = {}) => ({
    candidate_id: candidateId,
    source_type: 'mission',
    source_ref: sourceRef,
    knowledge_domain: 'product',
    approval_channel: 'pr_review',
    sensitivity_tier: 'public',
    proposed_memory_kind: 'heuristic',
    status: 'approved',
    queued_at: `2026-09-30T00:00:0${candidateId.length % 10}.000Z`,
    ...extra,
  });

  beforeEach(() => {
    promoteCandidate.mockClear();
    queueRows.mockReturnValue([
      row('MEM-A-PR', 'mission:MSN-KL-A'),
      row('MEM-A-TASK', 'mission:MSN-KL-A:task-1'),
      row('MEM-A-ORG', 'mission:MSN-KL-A', {
        knowledge_domain: 'organization',
        approval_channel: 'steward',
      }),
      row('MEM-A-STEWARD', 'mission:MSN-KL-A', { approval_channel: 'steward' }),
      row('MEM-AB-PREFIX', 'mission:MSN-KL-AB'),
      row('MEM-B-PR', 'mission:MSN-KL-B'),
      row('MEM-A-QUEUED', 'mission:MSN-KL-A', { status: 'queued' }),
    ]);
  });

  it('requires --mission when --target-root is given', async () => {
    await expect(promotePendingMemoryCandidates({ targetRoot: '/wt/pr' })).rejects.toThrow(
      /--target-root requires --mission <ID>/
    );
    expect(promoteCandidate).not.toHaveBeenCalled();
  });

  it("promotes only that mission's pr_review product candidates and skips the rest", async () => {
    await promotePendingMemoryCandidates({ targetRoot: '/wt/pr', missionId: 'msn-kl-a' });
    const promotedIds = promoteCandidate.mock.calls.map(([input]) => input.candidateId).sort();
    expect(promotedIds).toEqual(['MEM-A-PR', 'MEM-A-TASK']);
    for (const [input] of promoteCandidate.mock.calls) {
      expect(input.targetRoot).toBe('/wt/pr');
    }
  });

  it('filters by mission without --target-root and keeps non-product candidates', async () => {
    await promotePendingMemoryCandidates({ missionId: 'MSN-KL-A' });
    const promotedIds = promoteCandidate.mock.calls.map(([input]) => input.candidateId).sort();
    expect(promotedIds).toEqual(['MEM-A-ORG', 'MEM-A-PR', 'MEM-A-STEWARD', 'MEM-A-TASK']);
  });
});
