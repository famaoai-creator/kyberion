import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  memoryPromotionQueuePath,
  updateMemoryPromotionCandidateStatus,
} from './memory-promotion-queue.js';
import { loadDistillCandidateRecord } from './distill-candidate-registry.js';
import { promoteMemoryCandidateToKnowledge } from './memory-promotion-workflow.js';

describe('memory-promotion-workflow', () => {
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

  it('promotes an approved candidate into distill and governed memory artifacts', () => {
    const queued = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-PROMOTION-1',
      proposedMemoryKind: 'sop',
      summary: 'Reusable mission closure checklist for operational maintenance.',
      evidenceRefs: ['active/missions/MSN-TEST-PROMOTION-1/evidence/ledger.jsonl'],
      sensitivityTier: 'confidential',
      ratificationRequired: true,
    });
    enqueueMemoryPromotionCandidate(queued);
    updateMemoryPromotionCandidateStatus({
      candidateId: queued.candidate_id,
      status: 'approved',
      ratificationNote: 'Approved for promotion in governance review.',
    });

    const result = promoteMemoryCandidateToKnowledge({
      candidateId: queued.candidate_id,
      executionRole: 'mission_controller',
    });

    expect(result.candidate.status).toBe('promoted');
    expect(result.promotedRef).toContain('knowledge/confidential');

    const distill = loadDistillCandidateRecord(queued.candidate_id);
    expect(distill?.status).toBe('promoted');
    expect(distill?.promoted_ref).toBe(result.promotedRef);
  });

  it('rejects promotion when ratification is required but not approved', () => {
    const queued = createMemoryPromotionCandidate({
      sourceType: 'task_session',
      sourceRef: 'task_session:TSK-TEST-PROMOTION-2',
      proposedMemoryKind: 'template',
      summary: 'A reusable status report template candidate.',
      evidenceRefs: ['artifact:ART-TEST-PROMOTION-2'],
      sensitivityTier: 'confidential',
      ratificationRequired: true,
    });
    enqueueMemoryPromotionCandidate(queued);

    expect(() =>
      promoteMemoryCandidateToKnowledge({
        candidateId: queued.candidate_id,
      }),
    ).toThrow(/requires ratification/i);
  });
});
