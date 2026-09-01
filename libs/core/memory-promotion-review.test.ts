import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  memoryPromotionQueuePath,
} from './memory-promotion-queue.js';
import {
  assertMemoryPromotionReviewReady,
  reviewMemoryPromotionCandidate,
  reviewMemoryPromotionQueue,
} from './memory-promotion-review.js';

process.env.KYBERION_MEMORY_QUEUE_PATH =
  'active/shared/tmp/test-memory-queue-memory-promotion-review.jsonl';

describe('memory-promotion-review', () => {
  const queuePath = memoryPromotionQueuePath();
  let originalQueueRaw: string | null = null;

  beforeAll(() => {
    if (safeExistsSync(queuePath)) {
      originalQueueRaw = safeReadFile(queuePath, { encoding: 'utf8' }) as string;
    }
  });

  beforeEach(() => {
    if (safeExistsSync(queuePath)) safeRmSync(queuePath);
  });

  afterAll(() => {
    if (originalQueueRaw !== null) {
      safeWriteFile(queuePath, originalQueueRaw);
      return;
    }
    if (safeExistsSync(queuePath)) safeRmSync(queuePath);
  });

  it('explains why a legacy confidential candidate is held', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-HOLD-1',
      sourceType: 'mission',
      sourceRef: 'MSN-REVIEW-HOLD-1',
      proposedMemoryKind: 'heuristic',
      summary: 'A review candidate with inspectable evidence.',
      evidenceRefs: ['package.json', 'artifact:ART-REVIEW-1'],
      sensitivityTier: 'confidential',
    });
    enqueueMemoryPromotionCandidate({ ...candidate, audit_ref: 'audit:AUD-MISSING-1' });

    const [review] = reviewMemoryPromotionCandidate(candidate.candidate_id);
    expect(review).toMatchObject({
      candidate_id: 'MEM-REVIEW-HOLD-1',
      review_status: 'hold',
      target_kind: 'knowledge_hint',
      target_path: 'knowledge/confidential/common/wisdom/generated/MEM-REVIEW-HOLD-1.md',
      physical_record_count: 1,
    });
    expect(review.evidence).toEqual([
      expect.objectContaining({ ref: 'package.json', status: 'present' }),
      expect.objectContaining({ ref: 'artifact:ART-REVIEW-1', status: 'logical' }),
    ]);
    expect(review.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(['missing_audit_entry', 'missing_tenant_scope'])
    );
    expect(() => assertMemoryPromotionReviewReady(review, 'approve')).toThrow(
      /MEMORY_PROMOTION_HOLD/
    );
  });

  it('groups duplicate physical records and exposes the duplicate blocker', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-DUPLICATE-1',
      sourceType: 'task_session',
      sourceRef: 'task_session:TS-REVIEW-DUPLICATE-1',
      proposedMemoryKind: 'clarification_prompt',
      summary: 'A tenant-scoped repeated clarification candidate.',
      evidenceRefs: ['artifact:ART-REVIEW-DUPLICATE-1'],
      sensitivityTier: 'confidential',
      scope: {
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        promotion_policy: 'same_scope',
      },
    });
    const queued = { ...candidate, audit_ref: 'audit:AUD-MISSING-DUPLICATE-1' };
    enqueueMemoryPromotionCandidate(queued);
    safeAppendFileSync(queuePath, `${JSON.stringify(queued)}\n`);

    const reviews = reviewMemoryPromotionQueue('queued');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      candidate_id: 'MEM-REVIEW-DUPLICATE-1',
      physical_record_count: 2,
      duplicate_count: 1,
      review_status: 'hold',
    });
    expect(reviews[0].blockers.map((blocker) => blocker.code)).toContain('duplicate_records');
  });

  it('treats external evidence paths as missing without reading them', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-EXTERNAL-EVIDENCE-1',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-REVIEW-EXTERNAL-EVIDENCE-1',
      proposedMemoryKind: 'heuristic',
      summary: 'A candidate with an out-of-scope evidence path.',
      evidenceRefs: ['/tmp/external-memory-evidence.md'],
      sensitivityTier: 'public',
    });
    enqueueMemoryPromotionCandidate({ ...candidate, audit_ref: 'audit:AUD-MISSING-EXTERNAL-1' });

    const [review] = reviewMemoryPromotionCandidate(candidate.candidate_id);
    expect(review.evidence).toEqual([
      expect.objectContaining({
        ref: '/tmp/external-memory-evidence.md',
        status: 'missing',
      }),
    ]);
    expect(review.blockers.map((blocker) => blocker.code)).toContain('missing_evidence');
  });

  it('does not hide conflicting duplicate content behind the first physical row', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-CONFLICT-1',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-REVIEW-CONFLICT-1',
      proposedMemoryKind: 'heuristic',
      summary: 'The original candidate summary.',
      evidenceRefs: ['artifact:ART-REVIEW-CONFLICT-1'],
      sensitivityTier: 'public',
    });
    enqueueMemoryPromotionCandidate({ ...candidate, audit_ref: 'audit:AUD-MISSING-CONFLICT-1' });
    safeAppendFileSync(
      queuePath,
      `${JSON.stringify({
        ...candidate,
        summary: 'A different duplicate summary.',
        audit_ref: 'audit:AUD-MISSING-CONFLICT-2',
      })}\n`
    );

    const [review] = reviewMemoryPromotionCandidate(candidate.candidate_id);
    expect(review.record_conflicts).toEqual(['audit_ref', 'summary']);
    expect(review.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(['duplicate_records', 'conflicting_records'])
    );
    expect(review.review_status).toBe('hold');
  });

  it('uses the requested status row when filtering a duplicate group', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-FILTER-1',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-REVIEW-FILTER-1',
      proposedMemoryKind: 'heuristic',
      summary: 'A candidate with mixed physical status rows.',
      evidenceRefs: ['artifact:ART-REVIEW-FILTER-1'],
      sensitivityTier: 'public',
    });
    enqueueMemoryPromotionCandidate({ ...candidate, status: 'rejected' });
    safeAppendFileSync(queuePath, `${JSON.stringify({ ...candidate, status: 'queued' })}\n`);

    const [review] = reviewMemoryPromotionQueue('queued');
    expect(review.candidate.status).toBe('queued');
    expect(review.queue_statuses).toEqual(expect.arrayContaining(['queued', 'rejected']));
  });

  it('keeps different audience scopes separate', () => {
    const base = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-AUDIENCE-1',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-REVIEW-AUDIENCE-1',
      proposedMemoryKind: 'heuristic',
      summary: 'Audience-specific candidate.',
      evidenceRefs: ['artifact:ART-REVIEW-AUDIENCE-1'],
      sensitivityTier: 'confidential',
      scope: {
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        allowed_audience: ['principal:a'],
      },
    });
    const otherAudience = {
      ...base,
      scope: {
        ...base.scope,
        allowed_audience: ['principal:b'],
      },
    };
    enqueueMemoryPromotionCandidate({ ...base, audit_ref: 'audit:AUD-MISSING-AUDIENCE-1' });
    enqueueMemoryPromotionCandidate({
      ...otherAudience,
      audit_ref: 'audit:AUD-MISSING-AUDIENCE-2',
    });

    expect(reviewMemoryPromotionCandidate(base.candidate_id)).toHaveLength(2);
  });
});
