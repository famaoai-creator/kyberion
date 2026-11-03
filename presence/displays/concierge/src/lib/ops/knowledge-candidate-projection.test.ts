import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
const mocks = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('@agent/core/knowledge/scoped-learning-workflow', () => ({
  inspectScopedLearningReview: mocks.inspect,
}));
vi.mock('./memory-candidate-selection', () => ({ memoryCandidateKey: () => 'a'.repeat(64) }));
import { projectKnowledgeCandidate } from './knowledge-candidate-projection';
const candidate: MemoryCandidate = {
  candidate_id: 'MEM-PROJECTION',
  source_type: 'artifact',
  source_ref: 'artifact:one',
  summary: 'Authorized summary',
  evidence_refs: ['artifact:one'],
  proposed_memory_kind: 'sop',
  knowledge_domain: 'organization',
  sensitivity_tier: 'confidential',
  scope: { tier: 'confidential', tenant_slug: 'acme' },
  status: 'queued',
  ratification_required: true,
  queued_at: '2026-10-20T00:00:00Z',
};
beforeEach(() => vi.clearAllMocks());
describe('knowledge candidate HTTP projection', () => {
  it('never emits internal diagnostic reasons or future inspector fields', () => {
    mocks.inspect.mockReturnValue({
      candidate,
      learning: {
        state: 'error',
        payloadDigest: 'b'.repeat(64),
        reason: 'Denied /private/tenant/internal-path',
        internalStack: 'private stack',
      },
    });
    const projected = projectKnowledgeCandidate(candidate);
    expect(projected.learning).toEqual({ state: 'error', payloadDigest: 'b'.repeat(64) });
    expect(JSON.stringify(projected)).not.toMatch(
      /internal-path|private stack|reason|internalStack/
    );
  });
  it('keeps refreshed payload and review state together for the same exact identity', () => {
    const refreshed = { ...candidate, summary: 'Current summary' };
    mocks.inspect.mockReturnValue({
      candidate: refreshed,
      learning: {
        state: 'approved',
        payloadDigest: 'c'.repeat(64),
        approvalRef: 'terminal:review',
      },
    });
    expect(projectKnowledgeCandidate(candidate)).toMatchObject({
      summary: 'Current summary',
      candidateKey: 'a'.repeat(64),
      learning: {
        state: 'approved',
        payloadDigest: 'c'.repeat(64),
        approvalRef: 'terminal:review',
      },
    });
  });
  it('does not invoke scoped review or attach diagnostics to legacy candidates', () => {
    const legacy = { ...candidate, scope: undefined };
    expect(projectKnowledgeCandidate(legacy)).not.toHaveProperty('learning');
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});
