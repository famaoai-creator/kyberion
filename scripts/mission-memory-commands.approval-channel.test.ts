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
vi.mock('@agent/core/knowledge/memory-promotion-queue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateMemoryPromotionCandidateStatus: (input: unknown) => {
    updateStatus(input);
    return { candidate_id: 'MEM-KL04-CLI' };
  },
}));

import { approveMemoryCandidate } from './refactor/mission-memory-commands.js';
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
});
