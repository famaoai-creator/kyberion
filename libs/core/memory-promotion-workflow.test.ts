import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safeExistsSync,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  memoryPromotionQueuePath,
  updateMemoryPromotionCandidateStatus,
} from './memory-promotion-queue.js';
import { loadDistillCandidateRecord } from './distill-candidate-registry.js';
import {
  promoteMemoryCandidateToKnowledge,
  promotePersonalMemoryCandidates,
} from './memory-promotion-workflow.js';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from './reasoning-backend.js';
import { buildScopedIndex, queryKnowledgeHybrid } from './src/knowledge-index.js';

// Namespace the promotion queue so parallel test files never clobber the
// real shared queue (root cause of combined-run flakes).
process.env.KYBERION_MEMORY_QUEUE_PATH =
  'active/shared/tmp/test-memory-queue-memory-promotion-workflow.jsonl';

vi.mock('./src/knowledge-index.js', () => ({
  buildScopedIndex: vi.fn(async () => ({ hints: [] })),
  queryKnowledgeHybrid: vi.fn(),
}));

const mockQueryKnowledgeHybrid = vi.mocked(queryKnowledgeHybrid);
const mockBuildScopedIndex = vi.mocked(buildScopedIndex);

describe('memory-promotion-workflow', () => {
  const queuePath = memoryPromotionQueuePath();
  let originalQueueRaw: string | null = null;
  const originalAutopromote = process.env.KYBERION_MEMORY_AUTOPROMOTE;

  // Promotion writes through to the real governed HINTS.md and creates
  // distill/promoted-memory artifacts; snapshot and clean so test runs never
  // pollute committed knowledge files (KM-04 hygiene).
  const hintsPath = pathResolver.knowledge('product/governance/HINTS.md');
  const distillDir = pathResolver.shared('runtime/distill-candidates');
  let originalHintsRaw: string | null = null;
  let distillEntriesBefore = new Set<string>();

  function cleanupPromotionArtifacts(): void {
    withExecutionContext('ecosystem_architect', () => {
      const entriesNow = safeExistsSync(distillDir) ? safeReaddir(distillDir) : [];
      for (const entry of entriesNow) {
        if (distillEntriesBefore.has(entry)) continue;
        const recordPath = `${distillDir}/${entry}`;
        try {
          const record = JSON.parse(safeReadFile(recordPath, { encoding: 'utf8' }) as string) as {
            promoted_ref?: string;
          };
          const promotedRef = String(record.promoted_ref || '');
          if (promotedRef) {
            for (const artifact of [promotedRef, promotedRef.replace(/\.md$/, '.json')]) {
              const absArtifact = pathResolver.resolve(artifact);
              if (safeExistsSync(absArtifact)) safeRmSync(absArtifact);
            }
          }
        } catch {
          /* best-effort — still remove the record below */
        }
        safeRmSync(recordPath);
      }
    });
  }

  beforeAll(() => {
    if (safeExistsSync(queuePath)) {
      originalQueueRaw = safeReadFile(queuePath, { encoding: 'utf8' }) as string;
    }
    if (safeExistsSync(hintsPath)) {
      originalHintsRaw = safeReadFile(hintsPath, { encoding: 'utf8' }) as string;
    }
  });

  beforeEach(() => {
    if (safeExistsSync(queuePath)) safeRmSync(queuePath);
    distillEntriesBefore = new Set(safeExistsSync(distillDir) ? safeReaddir(distillDir) : []);
  });

  afterEach(() => {
    cleanupPromotionArtifacts();
  });

  afterAll(() => {
    resetReasoningBackend();
    withExecutionContext('ecosystem_architect', () => {
      if (originalHintsRaw !== null) {
        safeWriteFile(hintsPath, originalHintsRaw);
      } else if (safeExistsSync(hintsPath)) {
        safeRmSync(hintsPath);
      }
    });
    if (originalQueueRaw !== null) {
      safeWriteFile(queuePath, originalQueueRaw);
      return;
    }
    if (safeExistsSync(queuePath)) safeRmSync(queuePath);
  });

  beforeEach(() => {
    resetReasoningBackend();
    vi.clearAllMocks();
    mockBuildScopedIndex.mockClear();
    mockQueryKnowledgeHybrid.mockClear();
    if (typeof originalAutopromote === 'string') {
      process.env.KYBERION_MEMORY_AUTOPROMOTE = originalAutopromote;
    } else {
      delete process.env.KYBERION_MEMORY_AUTOPROMOTE;
    }
  });

  afterEach(() => {
    if (typeof originalAutopromote === 'string') {
      process.env.KYBERION_MEMORY_AUTOPROMOTE = originalAutopromote;
    } else {
      delete process.env.KYBERION_MEMORY_AUTOPROMOTE;
    }
  });

  it('promotes an approved candidate into distill and governed memory artifacts', async () => {
    mockQueryKnowledgeHybrid.mockResolvedValue([
      {
        topic: 'reuse mission closing',
        hint: 'Keep the mission closing checklist concise and repeatable.',
        source: 'knowledge/public/procedures/mission-close.md',
        confidence: 0.91,
        tier: 'public',
        tags: ['mission', 'closure'],
      },
    ] as any);
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

    const result = await promoteMemoryCandidateToKnowledge({
      candidateId: queued.candidate_id,
      executionRole: 'mission_controller',
    });

    expect(result.candidate.status).toBe('promoted');
    expect(result.promotedRef).toContain('knowledge/confidential');
    expect(result.review.similar_knowledge).toHaveLength(1);
    expect(result.review.contradiction).toBeUndefined();
    expect(mockBuildScopedIndex).toHaveBeenCalledTimes(1);
    expect(mockQueryKnowledgeHybrid).toHaveBeenCalledWith(
      expect.anything(),
      'Reusable mission closure checklist for operational maintenance.',
      {
        maxResults: 3,
      }
    );

    const distill = loadDistillCandidateRecord(queued.candidate_id);
    expect(distill?.status).toBe('promoted');
    expect(distill?.promoted_ref).toBe(result.promotedRef);
    expect(distill?.metadata?.promotion_review).toMatchObject({
      backend: 'stub',
      similar_knowledge: [
        {
          topic: 'reuse mission closing',
          source: 'knowledge/public/procedures/mission-close.md',
        },
      ],
    });
  });

  it('runs the contradiction check on non-stub backends and records the result', async () => {
    mockQueryKnowledgeHybrid.mockResolvedValue([
      {
        topic: 'reuse mission closing',
        hint: 'Keep the mission closing checklist concise and repeatable.',
        source: 'knowledge/public/procedures/mission-close.md',
        confidence: 0.91,
        tier: 'public',
        tags: ['mission', 'closure'],
      },
    ] as any);
    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'anthropic',
      prompt: vi.fn(async () =>
        JSON.stringify({ verdict: 'yes', reason: 'conflicts with the existing checklist.' })
      ),
    });

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
    updateMemoryPromotionCandidateStatus({
      candidateId: queued.candidate_id,
      status: 'approved',
      ratificationNote: 'Approved for promotion in governance review.',
    });

    const result = await promoteMemoryCandidateToKnowledge({
      candidateId: queued.candidate_id,
      executionRole: 'mission_controller',
    });

    expect(result.review.contradiction).toEqual({
      verdict: 'yes',
      reason: 'conflicts with the existing checklist.',
    });

    const distill = loadDistillCandidateRecord(queued.candidate_id);
    expect(distill?.metadata?.promotion_review?.contradiction).toEqual({
      verdict: 'yes',
      reason: 'conflicts with the existing checklist.',
    });
  });

  it('rejects promotion when ratification is required but not approved', async () => {
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

    await expect(
      promoteMemoryCandidateToKnowledge({
        candidateId: queued.candidate_id,
      })
    ).rejects.toThrow(/requires ratification/i);
  });

  it('blocks environment-specific background review notes before knowledge promotion', async () => {
    const queued = createMemoryPromotionCandidate({
      sourceType: 'task_session',
      sourceRef: 'task_session:TSK-TEST-BACKGROUND-REVIEW-1',
      proposedMemoryKind: 'heuristic',
      summary: 'The run failed with ECONNRESET; the provider is unreliable.',
      evidenceRefs: ['artifact:ART-TEST-BACKGROUND-REVIEW-1'],
      sensitivityTier: 'confidential',
      ratificationRequired: true,
    });
    enqueueMemoryPromotionCandidate(queued);
    updateMemoryPromotionCandidateStatus({
      candidateId: queued.candidate_id,
      status: 'approved',
      ratificationNote: 'Approved for policy gate test.',
    });

    await expect(
      promoteMemoryCandidateToKnowledge({
        candidateId: queued.candidate_id,
        executionRole: 'mission_controller',
      })
    ).rejects.toThrow(/Background review policy|POLICY_VIOLATION/);
    expect(
      (await import('./memory-promotion-queue.js')).loadMemoryPromotionCandidate(
        queued.candidate_id
      )
    ).toMatchObject({ status: 'rejected' });
    expect(loadDistillCandidateRecord(queued.candidate_id)).toBeNull();
  });

  it('autopromotes eligible personal mission candidates when enabled', async () => {
    process.env.KYBERION_MEMORY_AUTOPROMOTE = 'personal';
    mockQueryKnowledgeHybrid.mockResolvedValue([] as any);

    const queued = createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef: 'mission:MSN-TEST-AUTOPROMOTE',
      proposedMemoryKind: 'heuristic',
      summary: 'Reusable weekly review note for the mission closure checklist.',
      evidenceRefs: ['active/missions/MSN-TEST-AUTOPROMOTE/evidence/ledger.jsonl'],
      sensitivityTier: 'personal',
    });
    enqueueMemoryPromotionCandidate(queued);

    const result = await promotePersonalMemoryCandidates({
      executionRole: 'mission_controller',
      ratificationNote: 'Autopromoted from test.',
    });

    expect(result.enabled).toBe(true);
    expect(result.promoted).toContain(queued.candidate_id);
    expect(result.skipped).toHaveLength(0);

    const promoted = loadDistillCandidateRecord(queued.candidate_id);
    expect(promoted?.status).toBe('promoted');
    expect(promoted?.metadata?.promotion_review?.similar_knowledge).toEqual([]);
  });
});
