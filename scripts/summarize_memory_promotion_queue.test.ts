import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  memoryPromotionQueuePath,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { summarizeMemoryPromotionQueue } from './summarize_memory_promotion_queue.js';

describe('summarize_memory_promotion_queue', () => {
  const TEST_QUEUE_OVERRIDE = 'active/shared/tmp/test-memory-promotion-summary.jsonl';
  let queuePath: string;
  let originalQueueOverride: string | undefined;
  let originalQueueRaw: string | null = null;

  beforeAll(() => {
    originalQueueOverride = process.env.KYBERION_MEMORY_QUEUE_PATH;
    process.env.KYBERION_MEMORY_QUEUE_PATH = TEST_QUEUE_OVERRIDE;
    queuePath = memoryPromotionQueuePath();
    if (safeExistsSync(queuePath)) {
      originalQueueRaw = safeReadFile(queuePath, { encoding: 'utf8' }) as string;
    }
  });

  afterAll(() => {
    if (originalQueueRaw !== null) {
      safeWriteFile(queuePath, originalQueueRaw);
    } else if (safeExistsSync(queuePath)) {
      safeRmSync(queuePath);
    }
    if (originalQueueOverride === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
    else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueueOverride;
  });

  it('summarizes queued candidates with age information', () => {
    if (safeExistsSync(queuePath)) safeRmSync(queuePath);

    const candidate = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-QUEUE-SUMMARY',
      proposedMemoryKind: 'heuristic',
      summary: 'Reusable operational hint for weekly review.',
      evidenceRefs: ['active/missions/MSN-QUEUE-SUMMARY/evidence/ledger.jsonl'],
      sensitivityTier: 'personal',
      queuedAt: '2026-07-01T00:00:00.000Z',
    });
    enqueueMemoryPromotionCandidate(candidate);

    const rows = summarizeMemoryPromotionQueue('queued');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidate_id: candidate.candidate_id,
      status: 'queued',
      source_ref: 'mission:MSN-QUEUE-SUMMARY',
      occurrences: 1,
      ratification_required: false,
    });
    expect(rows[0]?.age_days).toBeGreaterThanOrEqual(0);
  });
});
