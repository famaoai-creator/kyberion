import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
  queueMissionMemoryPromotionCandidate,
  updateMemoryPromotionCandidateStatus,
} from './memory-promotion-queue.js';
import { pathResolver } from './path-resolver.js';

// Keep the aggregate read from discovering the repository's real tenant
// shards during this queue-unit suite.
process.env.KYBERION_MEMORY_QUEUE_PATH =
  'active/shared/tmp/test-memory-queue-memory-promotion-queue.jsonl';

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

  it('rejects public-tier candidates that reference confidential mission artifacts', () => {
    const candidate = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-CONFIDENTIAL-REF',
      proposedMemoryKind: 'sop',
      summary: 'Public promotion must not leak confidential mission evidence.',
      evidenceRefs: ['active/missions/confidential/MSN-TEST-CONFIDENTIAL-REF/evidence/trace.jsonl'],
      sensitivityTier: 'public',
    });
    expect(() => enqueueMemoryPromotionCandidate(candidate)).toThrow(/public-tier/i);
  });

  it('requires brokered redaction before a tenant-scoped candidate can become public', () => {
    const candidate = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-BROKERED-MEMORY',
      proposedMemoryKind: 'heuristic',
      summary: 'A redacted reusable pattern.',
      evidenceRefs: ['evidence:MSN-TEST-BROKERED-MEMORY'],
      sensitivityTier: 'public',
      scope: {
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        mission_id: 'MSN-TEST-BROKERED-MEMORY',
        owner_nhi: 'kyberion://agent/org-a/planner',
      },
    });

    expect(() => enqueueMemoryPromotionCandidate(candidate)).toThrow(
      /brokered, redacted promotion/
    );
    expect(() =>
      enqueueMemoryPromotionCandidate({
        ...candidate,
        promotion: {
          source_tenant_slug: 'acme-corp',
          target_tier: 'public',
          redacted: true,
          approved_by: 'human:steward',
        },
      })
    ).not.toThrow();
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

  it('deduplicates queued candidates by source_ref and content hash', () => {
    const first = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-DEDUP',
      proposedMemoryKind: 'heuristic',
      summary: 'Reuse the weekly review summary step.',
      evidenceRefs: ['active/missions/MSN-TEST-DEDUP/evidence/one.jsonl'],
      sensitivityTier: 'personal',
      queuedAt: '2026-07-01T00:00:00.000Z',
    });
    enqueueMemoryPromotionCandidate(first);

    const second = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-DEDUP',
      proposedMemoryKind: 'heuristic',
      summary: 'Reuse the weekly review summary step.',
      evidenceRefs: ['active/missions/MSN-TEST-DEDUP/evidence/two.jsonl'],
      sensitivityTier: 'personal',
      queuedAt: '2026-07-02T00:00:00.000Z',
    });
    enqueueMemoryPromotionCandidate(second);

    const rows = listMemoryPromotionCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.candidate_id).toBe(first.candidate_id);
    expect(rows[0]?.occurrences).toBe(2);
    expect(rows[0]?.last_seen).toBe('2026-07-02T00:00:00.000Z');
    expect(rows[0]?.evidence_refs).toEqual([
      'active/missions/MSN-TEST-DEDUP/evidence/one.jsonl',
      'active/missions/MSN-TEST-DEDUP/evidence/two.jsonl',
    ]);
  });

  it('deduplicates against legacy queue rows without content_hash', () => {
    safeWriteFile(
      queuePath,
      `${JSON.stringify({
        candidate_id: 'MEM-LEGACY-1',
        source_type: 'mission',
        source_ref: 'mission:MSN-TEST-LEGACY',
        proposed_memory_kind: 'heuristic',
        summary: 'Reuse the weekly review summary step.',
        evidence_refs: ['active/missions/MSN-TEST-LEGACY/evidence/one.jsonl'],
        sensitivity_tier: 'personal',
        ratification_required: false,
        status: 'queued',
        queued_at: '2026-07-01T00:00:00.000Z',
      })}\n`
    );

    const candidate = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-LEGACY',
      proposedMemoryKind: 'heuristic',
      summary: 'Reuse the weekly review summary step.',
      evidenceRefs: ['active/missions/MSN-TEST-LEGACY/evidence/two.jsonl'],
      sensitivityTier: 'personal',
      queuedAt: '2026-07-03T00:00:00.000Z',
    });
    enqueueMemoryPromotionCandidate(candidate);

    const rows = listMemoryPromotionCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.candidate_id).toBe('MEM-LEGACY-1');
    expect(rows[0]?.content_hash).toBeTruthy();
    expect(rows[0]?.occurrences).toBe(2);
    expect(rows[0]?.last_seen).toBe('2026-07-03T00:00:00.000Z');
  });

  it('never deduplicates candidates across tenant scopes', () => {
    const acme = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-CROSS-TENANT',
      proposedMemoryKind: 'heuristic',
      summary: 'Same wording in separate tenants.',
      evidenceRefs: ['knowledge/confidential/acme/evidence.jsonl'],
      sensitivityTier: 'confidential',
      scope: { tier: 'confidential', tenant_slug: 'acme-corp' },
    });
    const beta = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-CROSS-TENANT',
      proposedMemoryKind: 'heuristic',
      summary: 'Same wording in separate tenants.',
      evidenceRefs: ['knowledge/confidential/beta/evidence.jsonl'],
      sensitivityTier: 'confidential',
      scope: { tier: 'confidential', tenant_slug: 'beta-corp' },
    });

    enqueueMemoryPromotionCandidate(acme);
    enqueueMemoryPromotionCandidate(beta);

    const rows = listMemoryPromotionCandidates();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.scope?.tenant_slug)).toEqual(['acme-corp', 'beta-corp']);
    expect(rows[0]?.evidence_refs).toEqual(['knowledge/confidential/acme/evidence.jsonl']);
    expect(rows[1]?.evidence_refs).toEqual(['knowledge/confidential/beta/evidence.jsonl']);
  });

  it('resolves tenant-scoped queues below the physical tenant runtime namespace', () => {
    const originalOverride = process.env.KYBERION_MEMORY_QUEUE_PATH;
    delete process.env.KYBERION_MEMORY_QUEUE_PATH;
    try {
      expect(
        memoryPromotionQueuePath({ tier: 'confidential', tenant_slug: 'acme-corp' })
      ).toContain('active/shared/runtime/tenants/acme-corp/memory/promotion-queue.jsonl');
      expect(memoryPromotionQueuePath()).toContain(
        'active/shared/runtime/memory/promotion-queue.jsonl'
      );
    } finally {
      if (originalOverride === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
      else process.env.KYBERION_MEMORY_QUEUE_PATH = originalOverride;
    }
  });

  it('updates every duplicate in one scope only when explicitly requested', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-TEST-ALL-DUPLICATES',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-ALL-DUPLICATES',
      proposedMemoryKind: 'heuristic',
      summary: 'Reject every physical duplicate in this scope.',
      evidenceRefs: ['artifact:ART-TEST-ALL-DUPLICATES'],
      sensitivityTier: 'public',
    });
    enqueueMemoryPromotionCandidate(candidate);
    safeAppendFileSync(queuePath, `${JSON.stringify(candidate)}\n`);

    const updated = updateMemoryPromotionCandidateStatus({
      candidateId: candidate.candidate_id,
      status: 'rejected',
      allMatching: true,
    });
    expect(updated?.status).toBe('rejected');
    const rows = listMemoryPromotionCandidates();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'rejected')).toBe(true);
  });

  it('rejects a queue override outside the repository', () => {
    const originalOverride = process.env.KYBERION_MEMORY_QUEUE_PATH;
    process.env.KYBERION_MEMORY_QUEUE_PATH = '/tmp/memory-promotion-queue-external.jsonl';
    try {
      expect(() => memoryPromotionQueuePath()).toThrow('[RESOURCE_PATH_SCOPE]');
    } finally {
      process.env.KYBERION_MEMORY_QUEUE_PATH = originalOverride;
    }
  });

  it('rejects a queue override that traverses a symbolic link', () => {
    const targetPath = pathResolver.sharedTmp(`memory-queue-target-${process.pid}.jsonl`);
    const linkPath = pathResolver.sharedTmp(`memory-queue-link-${process.pid}.jsonl`);
    safeWriteFile(targetPath, '');
    safeSymlinkSync(targetPath, linkPath);
    const originalOverride = process.env.KYBERION_MEMORY_QUEUE_PATH;
    process.env.KYBERION_MEMORY_QUEUE_PATH = linkPath;
    try {
      expect(() => listMemoryPromotionCandidates()).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      process.env.KYBERION_MEMORY_QUEUE_PATH = originalOverride;
      safeUnlinkSync(linkPath);
      safeRmSync(targetPath, { force: true });
    }
  });
});
