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
  updateMemoryPromotionCandidateStatus,
  isPublicMemoryEvidencePath,
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

  it('holds an unclassified mission candidate until a steward selects its domain', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-UNCLASSIFIED-1',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-REVIEW-UNCLASSIFIED-1',
      proposedMemoryKind: 'heuristic',
      summary: 'A reusable lesson awaiting knowledge ownership classification.',
      evidenceRefs: ['mission:MSN-REVIEW-UNCLASSIFIED-1#evidence/distillation.md'],
      sensitivityTier: 'public',
      knowledgeDomain: 'unclassified',
    });
    enqueueMemoryPromotionCandidate({
      ...candidate,
      audit_ref: 'audit:AUD-MISSING-UNCLASSIFIED-1',
    });
    const [review] = reviewMemoryPromotionCandidate(candidate.candidate_id);
    expect(review.target_path).toContain('knowledge/unclassified/classification-required/');
    expect(review.blockers.map((blocker) => blocker.code)).toContain('unclassified_domain');
    expect(() => assertMemoryPromotionReviewReady(review, 'approve')).toThrow(
      /unclassified_domain/
    );
    expect(() =>
      updateMemoryPromotionCandidateStatus({
        candidateId: candidate.candidate_id,
        status: 'approved',
        knowledgeDomain: 'product',
      })
    ).toThrow(/evidence paths under knowledge\/public/);
  });

  it('rejects a public product label that points to confidential mission evidence', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-PRODUCT-CONFIDENTIAL-EVIDENCE-1',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-REVIEW-PRODUCT-CONFIDENTIAL-EVIDENCE-1',
      proposedMemoryKind: 'heuristic',
      summary: 'A product candidate points to a confidential mission artifact.',
      evidenceRefs: [
        'active/missions/confidential/MSN-REVIEW-PRODUCT-CONFIDENTIAL-EVIDENCE-1/evidence/summary.md',
      ],
      sensitivityTier: 'public',
      knowledgeDomain: 'product',
    });
    expect(() => enqueueMemoryPromotionCandidate(candidate)).toThrow(
      /evidence paths under knowledge\/public/
    );
  });

  it('rejects traversal from an allowed public evidence prefix', () => {
    expect(
      isPublicMemoryEvidencePath('active/missions/public/MSN-1/../../confidential/evidence.md')
    ).toBe(false);
    expect(isPublicMemoryEvidencePath('knowledge/public/../confidential/evidence.md')).toBe(false);
    expect(isPublicMemoryEvidencePath('knowledge/public/evidence/approved.md')).toBe(true);
  });

  it('requires an owner identity for personal-domain promotion', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-PERSONAL-OWNER-1',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-REVIEW-PERSONAL-OWNER-1',
      proposedMemoryKind: 'heuristic',
      summary: 'A private lesson awaiting its named knowledge owner.',
      evidenceRefs: ['mission:MSN-REVIEW-PERSONAL-OWNER-1#evidence/distillation.md'],
      sensitivityTier: 'personal',
      knowledgeDomain: 'personal',
      scope: { tier: 'personal' },
    });
    enqueueMemoryPromotionCandidate({
      ...candidate,
      audit_ref: 'audit:AUD-MISSING-PERSONAL-OWNER-1',
    });
    const [review] = reviewMemoryPromotionCandidate(candidate.candidate_id);
    expect(review.blockers.map((blocker) => blocker.code)).toContain('invalid_domain_scope');
    const approved = updateMemoryPromotionCandidateStatus({
      candidateId: candidate.candidate_id,
      status: 'approved',
      knowledgeDomain: 'personal',
      scopeUpdate: { tier: 'personal', owner_nhi: 'nhi:test-owner' },
      curation: {
        title: 'Private lesson',
        summary: 'A private lesson for this named knowledge owner.',
        content: 'Keep this lesson within the named personal owner namespace.',
        evidence_refs: candidate.evidence_refs,
      },
    });
    expect(approved?.scope?.owner_nhi).toBe('nhi:test-owner');
  });

  it('rejects product-domain candidates that are not public and unscoped at enqueue', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-REVIEW-PRODUCT-SCOPE-1',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-REVIEW-PRODUCT-SCOPE-1',
      proposedMemoryKind: 'heuristic',
      summary: 'A candidate incorrectly assigned to product knowledge.',
      evidenceRefs: ['knowledge/public/evidence/approved-summary.md'],
      sensitivityTier: 'confidential',
      knowledgeDomain: 'product',
      scope: { tier: 'confidential', tenant_slug: 'acme-corp' },
    });
    expect(() =>
      enqueueMemoryPromotionCandidate({
        ...candidate,
        audit_ref: 'audit:AUD-MISSING-PRODUCT-SCOPE-1',
      })
    ).toThrow(/public, unscoped/);
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
