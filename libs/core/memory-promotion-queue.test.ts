import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
  queueMissionMemoryPromotionCandidate,
  updateMemoryPromotionCandidateStatus,
} from './memory-promotion-queue.js';

describe('memory-promotion-queue', () => {
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

  it('enqueues and lists memory candidates', () => {
    const one = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-QUEUE-1',
      proposedMemoryKind: 'sop',
      summary: 'Promote repeatable mission closing flow.',
      evidenceRefs: ['active/missions/MSN-TEST-QUEUE-1/evidence/ledger.jsonl'],
      sensitivityTier: 'confidential',
    });
    enqueueMemoryPromotionCandidate(one);

    const two = createMemoryPromotionCandidate({
      sourceType: 'task_session',
      sourceRef: 'task_session:TSK-TEST-QUEUE-1',
      proposedMemoryKind: 'template',
      summary: 'Promote reusable delivery template.',
      evidenceRefs: ['artifact:ART-TEST-QUEUE-1'],
      sensitivityTier: 'public',
      ratificationRequired: true,
    });
    enqueueMemoryPromotionCandidate(two);

    const rows = listMemoryPromotionCandidates();
    expect(rows.length).toBe(2);
    expect(rows[0]?.candidate_id).toBe(one.candidate_id);
    expect(rows[1]?.candidate_id).toBe(two.candidate_id);
  });

  it('rejects candidates without evidence refs', () => {
    const candidate = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-NO-EVIDENCE',
      proposedMemoryKind: 'sop',
      summary: 'No evidence should fail.',
      evidenceRefs: [],
      sensitivityTier: 'confidential',
    });
    expect(() => enqueueMemoryPromotionCandidate(candidate)).toThrow(/evidence_ref/i);
  });

  it('rejects public-tier candidates that reference confidential or personal data', () => {
    const candidate = createMemoryPromotionCandidate({
      sourceType: 'artifact',
      sourceRef: 'artifact:ART-TEST-SCOPE',
      proposedMemoryKind: 'template',
      summary: 'Public promotion must not leak restricted refs.',
      evidenceRefs: ['knowledge/confidential/projects/acme/incident-42.md'],
      sensitivityTier: 'public',
    });
    expect(() => enqueueMemoryPromotionCandidate(candidate)).toThrow(/public-tier/i);
  });

  it('queues a mission candidate and supports status updates', () => {
    const queued = queueMissionMemoryPromotionCandidate({
      missionId: 'MSN-TEST-STATUS',
      missionType: 'incident_response',
      tier: 'confidential',
      summary: 'Mission produced reusable incident containment flow.',
      evidenceRefs: ['active/missions/MSN-TEST-STATUS/evidence/ledger.jsonl'],
    });
    expect(queued.source_ref).toBe('mission:MSN-TEST-STATUS');
    expect(queued.proposed_memory_kind).toBe('risk_rule');

    const updated = updateMemoryPromotionCandidateStatus({
      candidateId: queued.candidate_id,
      status: 'approved',
      ratificationNote: 'Validated by governance reviewer',
    });
    expect(updated?.status).toBe('approved');
    expect(updated?.ratified_at).toBeTruthy();
    expect(updated?.ratification_note).toContain('governance reviewer');
  });
});
