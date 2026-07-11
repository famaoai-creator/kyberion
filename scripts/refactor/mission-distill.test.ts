import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let missionPath = '';

vi.mock('./mission-llm.js', () => ({
  inspectLlmResolution: vi.fn(),
  resolveLlmConfig: vi.fn(),
  runAdaptiveStructuredLlmProfile: vi.fn(async () => {
    throw new Error('LLM unavailable in test');
  }),
}));

vi.mock('./src/knowledge-index.js', () => ({
  buildScopedIndex: vi.fn(async () => ({ hints: [] })),
  queryKnowledgeHybrid: vi.fn(async () => []),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    findMissionPath: vi.fn(() => missionPath),
    ledger: {
      ...actual.ledger,
      record: vi.fn(),
    },
  };
});

import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
  updateMemoryPromotionCandidateStatus,
} from '@agent/core';
import { loadDistillCandidateRecord } from '@agent/core';
import { loadState } from './mission-state.js';
import { distillMission } from './mission-distill.js';
import { promoteMemoryCandidateToKnowledge } from '@agent/core';
import { safeExec } from '@agent/core';

// Namespace the promotion queue so parallel test files never clobber the
// real shared queue (root cause of combined-run flakes).
process.env.KYBERION_MEMORY_QUEUE_PATH =
  'active/shared/tmp/test-memory-queue-mission-distill.jsonl';

describe('mission-distill end-to-end promotion flow', () => {
  const missionId = 'MSN-DISTILL-E2E-001';
  missionPath = pathResolver.shared('tmp/mission-distill-e2e');
  const queuePath = memoryPromotionQueuePath();
  const hintsPath = pathResolver.knowledge('product/governance/HINTS.md');
  const scratchHintsDir = pathResolver.shared('tmp/tests/mission-distill-hints');
  const scratchHintsPath = `${scratchHintsDir}/HINTS.md`;
  const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  const wisdomFileName = `distill_${missionId.toLowerCase()}_${dateSlug}.md`;
  const wisdomFilePath = pathResolver.rootResolve(`knowledge/product/evolution/${wisdomFileName}`);
  const promotedRecordBase = `mem-${missionId}-${dateSlug}`;
  const promotedKnowledgeDir = pathResolver.rootResolve('knowledge/public/common/wisdom/generated');
  let originalQueueRaw: string | null = null;
  let originalHintsRaw: string | null = null;

  function writeMissionState(): void {
    withExecutionContext('ecosystem_architect', () => {
      if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
      safeWriteFile(
        `${missionPath}/mission-state.json`,
        JSON.stringify(
          {
            mission_id: missionId,
            tier: 'public',
            status: 'distilling',
            execution_mode: 'local',
            priority: 1,
            assigned_persona: 'worker',
            confidence_score: 1,
            git: {
              branch: 'test',
              start_commit: 'abc123',
              latest_commit: safeExec('git', ['rev-parse', 'HEAD'], {
                cwd: pathResolver.rootDir(),
              }).trim(),
              checkpoints: [],
            },
            history: [
              {
                ts: '2026-07-04T00:00:00.000Z',
                event: 'VERIFY',
                note: 'Mission ready for distillation.',
              },
            ],
          },
          null,
          2
        )
      );
    });
  }

  beforeAll(() => {
    if (safeExistsSync(queuePath)) {
      originalQueueRaw = safeReadFile(queuePath, { encoding: 'utf8' }) as string;
    }
    if (safeExistsSync(hintsPath)) {
      originalHintsRaw = safeReadFile(hintsPath, { encoding: 'utf8' }) as string;
    }
    // Isolate hint rotation to a scratch copy: rewriting the real HINTS.md
    // mid-suite makes the parallel catalog-integrity test observe a dirty
    // knowledge tree (flaky failure) and litters hints/archive.
    withExecutionContext('ecosystem_architect', () => {
      safeMkdir(scratchHintsDir, { recursive: true });
      safeWriteFile(scratchHintsPath, originalHintsRaw ?? '');
    });
    process.env.KYBERION_HINTS_PATH = scratchHintsPath;
    process.env.KYBERION_HINTS_ARCHIVE_DIR = `${scratchHintsDir}/archive`;
  });

  beforeEach(() => {
    withExecutionContext('ecosystem_architect', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
      safeRmSync(queuePath, { force: true });
      safeRmSync(wisdomFilePath, { force: true });
      safeRmSync(`${promotedKnowledgeDir}/${promotedRecordBase}.json`, { force: true });
      safeRmSync(`${promotedKnowledgeDir}/${promotedRecordBase}.md`, { force: true });
    });
    writeMissionState();
  });

  afterAll(() => {
    withExecutionContext('ecosystem_architect', () => {
      if (originalQueueRaw !== null) {
        safeWriteFile(queuePath, originalQueueRaw);
      } else {
        safeRmSync(queuePath, { force: true });
      }
      delete process.env.KYBERION_HINTS_PATH;
      delete process.env.KYBERION_HINTS_ARCHIVE_DIR;
      safeRmSync(scratchHintsDir, { recursive: true, force: true });
      if (originalHintsRaw !== null && !safeExistsSync(hintsPath)) {
        safeWriteFile(hintsPath, originalHintsRaw);
      }
      safeRmSync(missionPath, { recursive: true, force: true });
      safeRmSync(wisdomFilePath, { force: true });
      safeRmSync(`${promotedKnowledgeDir}/${promotedRecordBase}.json`, { force: true });
      safeRmSync(`${promotedKnowledgeDir}/${promotedRecordBase}.md`, { force: true });
    });
  });

  it('distills a mission, queues a candidate, promotes it, and appends HINTS.md', async () => {
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'ecosystem_architect';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    try {
      await distillMission(missionId, pathResolver.rootDir());
    } finally {
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }

    const queued = listMemoryPromotionCandidates().find(
      (row) => row.candidate_id === `mem-${missionId}-${dateSlug}`
    );
    expect(queued).toBeTruthy();
    expect(queued?.status).toBe('queued');

    if (!queued) throw new Error('queued candidate missing');
    updateMemoryPromotionCandidateStatus({
      candidateId: queued.candidate_id,
      status: 'approved',
      ratificationNote: 'Approved for promotion in E2E test.',
    });

    const promotePreviousRole = process.env.MISSION_ROLE;
    const promotePreviousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'ecosystem_architect';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    let result;
    try {
      result = await promoteMemoryCandidateToKnowledge({
        candidateId: queued.candidate_id,
        executionRole: 'chronos_gateway',
      });
    } finally {
      if (promotePreviousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = promotePreviousRole;
      if (promotePreviousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = promotePreviousPersona;
    }

    expect(result.promotedRef).toContain('knowledge/public/common/wisdom/generated/');
    const distill = loadDistillCandidateRecord(queued.candidate_id);
    expect(distill?.status).toBe('promoted');
    expect(loadState(missionId)?.status).toBe('completed');

    const hints = safeReadFile(scratchHintsPath, { encoding: 'utf8' }) as string;
    expect(hints).toContain('Distilled wisdom from mission');
    expect(hints).toContain(`source_ref: ${queued.candidate_id}`);
    expect(hints).toContain(`knowledge/product/evolution/${wisdomFileName}`);
  });
});
