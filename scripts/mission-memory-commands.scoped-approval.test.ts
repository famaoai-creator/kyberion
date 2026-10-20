import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn(), update: vi.fn() }));
vi.mock('@agent/core/knowledge/memory-promotion-review', () => ({
  reviewMemoryPromotionCandidate: () => [
    {
      candidate_id: 'MEM-SCOPED-CLI',
      blockers: [],
      candidate: {
        candidate_id: 'MEM-SCOPED-CLI',
        source_type: 'task_session',
        source_ref: 'task_session:synthetic',
        knowledge_domain: 'organization',
        sensitivity_tier: 'confidential',
        proposed_memory_kind: 'sop',
        summary: 'Synthetic procedure',
        scope: { tier: 'confidential', tenant_slug: 'synthetic-review' },
        evidence_refs: ['task_session:synthetic'],
      },
    },
  ],
  reviewMemoryPromotionQueue: () => [],
  assertMemoryPromotionReviewReady: () => undefined,
}));
vi.mock('@agent/core/knowledge/scoped-learning-approval', () => ({
  requestScopedLearningApproval: mocks.request,
  verifyScopedLearningApprovalRef: vi.fn(),
}));
vi.mock('@agent/core/knowledge/memory-promotion-queue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateMemoryPromotionCandidateStatus: mocks.update,
}));
import { approveMemoryCandidate } from './refactor/mission-memory-commands.js';
const curation = JSON.stringify({
  title: 'Checked SOP',
  summary: 'Scoped reusable procedure',
  content: 'Check scope, execute, verify.',
  evidence_refs: ['task_session:synthetic'],
});
describe('memory-approve authenticated scoped review CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.request.mockReturnValue({ ref: 'terminal:test-request', status: 'pending' });
    mocks.update.mockReturnValue({ candidate_id: 'MEM-SCOPED-CLI' });
  });
  it('requests exact curated review without changing queue approval status', () => {
    const out: unknown[] = [];
    approveMemoryCandidate(
      'MEM-SCOPED-CLI',
      undefined,
      'synthetic-review',
      undefined,
      undefined,
      curation,
      undefined,
      'steward',
      (v) => out.push(v),
      { requestApproval: true }
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({ curation: JSON.parse(curation) }),
      })
    );
    expect(String(out[0])).toContain('terminal:test-request');
  });
  it('passes canonical shared approval reference to queue verification', () => {
    approveMemoryCandidate(
      'MEM-SCOPED-CLI',
      undefined,
      'synthetic-review',
      undefined,
      undefined,
      curation,
      undefined,
      'steward',
      undefined,
      { approvalRef: 'terminal:test-request' }
    );
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        learningApprovalRef: 'terminal:test-request',
        scope: { tier: 'confidential', tenant_slug: 'synthetic-review' },
      })
    );
  });
  it('refuses request/apply ambiguity before mutating either store', () => {
    expect(() =>
      approveMemoryCandidate(
        'MEM-SCOPED-CLI',
        undefined,
        undefined,
        undefined,
        undefined,
        curation,
        undefined,
        'steward',
        undefined,
        { requestApproval: true, approvalRef: 'terminal:test-request' }
      )
    ).toThrow(/not both/);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
