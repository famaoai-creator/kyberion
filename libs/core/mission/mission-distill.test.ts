import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

let missionPath = '';
let archiveLookupRoot = '';

vi.mock('./mission-llm.js', () => ({
  inspectLlmResolution: vi.fn(),
  resolveLlmConfig: vi.fn(),
  runAdaptiveStructuredLlmProfile: vi.fn(async () => {
    throw new Error('LLM unavailable in test');
  }),
}));

vi.mock('../knowledge/knowledge-index.js', () => ({
  buildScopedIndex: vi.fn(async () => ({ hints: [] })),
  queryKnowledgeHybrid: vi.fn(async () => []),
}));

// SO-01: mission-distill.ts now imports these directly from their libs/core
// sibling modules (not the @agent/core barrel) — the mocks must target the
// same specifiers or vitest won't intercept the real calls.
vi.mock('../path-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../path-resolver.js')>();
  const archiveLookup: typeof actual.findArchivedMissionDir = (id, options) =>
    actual.findArchivedMissionDir(id, {
      ...options,
      ...(archiveLookupRoot ? { archiveRoot: archiveLookupRoot } : {}),
    });
  return {
    ...actual,
    findMissionPath: vi.fn(() => missionPath || undefined),
    findArchivedMissionDir: archiveLookup,
    pathResolver: { ...actual.pathResolver, findArchivedMissionDir: archiveLookup },
  };
});
vi.mock('../ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ledger.js')>();
  return {
    ...actual,
    ledger: {
      ...actual.ledger,
      record: vi.fn(),
    },
  };
});

import * as pathResolver from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
  updateMemoryPromotionCandidateStatus,
} from '../knowledge/memory-promotion-queue.js';
import { loadDistillCandidateRecord } from '../knowledge/distill-candidate-registry.js';
import { loadMissionStateIncludingArchive, loadState } from './mission-state.js';
import {
  gatherDistillContext,
  distillMission,
  formatWisdomMarkdown,
  isRegularMissionDistillPromptPath,
  resolveWisdomOutputPath,
  WISDOM_SCHEMA,
} from './mission-distill.js';
import { promoteMemoryCandidateToKnowledge } from '../knowledge/memory-promotion-workflow.js';
import { safeExec } from '../secure-io.js';
import * as memoryQueue from '../knowledge/memory-promotion-queue.js';
import { runAdaptiveStructuredLlmProfile } from './mission-llm.js';
import { readJson, writeJson } from '../foundation/json.js';

// Namespace the promotion queue so parallel test files never clobber the
// real shared queue (root cause of combined-run flakes).
process.env.KYBERION_MEMORY_QUEUE_PATH =
  'active/shared/tmp/test-memory-queue-mission-distill.jsonl';

describe('mission-distill prompt resource loader', () => {
  it('accepts only existing regular prompt files', () => {
    const fixtureRoot = pathResolver.shared('tmp/mission-distill-prompt-loader-test');
    const filePath = `${fixtureRoot}/prompt.md`;
    const directoryPath = `${fixtureRoot}/prompt-directory.md`;
    try {
      safeWriteFile(filePath, 'distill prompt', { mkdir: true });
      safeMkdir(directoryPath, { recursive: true });

      expect(isRegularMissionDistillPromptPath(filePath)).toBe(true);
      expect(isRegularMissionDistillPromptPath(directoryPath)).toBe(false);
      expect(isRegularMissionDistillPromptPath(`${fixtureRoot}/missing.md`)).toBe(false);
    } finally {
      safeRmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe('mission-distill end-to-end promotion flow', () => {
  const missionId = 'MSN-DISTILL-E2E-001';
  missionPath = pathResolver.shared('tmp/mission-distill-e2e');
  const queuePath = memoryPromotionQueuePath();
  const hintsPath = pathResolver.knowledge('product/governance/HINTS.md');
  const scratchHintsDir = pathResolver.shared('tmp/tests/mission-distill-hints');
  const scratchHintsPath = `${scratchHintsDir}/HINTS.md`;
  const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  const wisdomFileName = 'distillation.md';
  const wisdomFilePath = `${missionPath}/evidence/${wisdomFileName}`;
  const promotedRecordBase = `mem-${missionId}-${dateSlug}`;
  const promotedKnowledgeDir = pathResolver.rootResolve(
    'knowledge/public/common/patterns/generated'
  );
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

  it('keeps raw distillation mission-local and queues a classified promotion candidate', async () => {
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
      knowledgeDomain: 'organization',
      curation: {
        title: 'Reusable mission lesson',
        summary: 'A durable lesson extracted from this mission evidence.',
        content: 'Describe the reusable lesson without retaining mission-specific detail.',
        evidence_refs: queued.evidence_refs,
      },
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

    expect(result.promotedRef).toContain('knowledge/public/common/patterns/generated/');
    const distill = loadDistillCandidateRecord(queued.candidate_id);
    expect(distill?.status).toBe('promoted');
    expect(loadState(missionId)?.status).toBe('completed');
    expect(loadState(missionId)?.distillation).toMatchObject({
      mode: 'structural',
      llm_used: false,
    });

    const hints = safeReadFile(scratchHintsPath, { encoding: 'utf8' }) as string;
    expect(hints).not.toContain('Distilled wisdom from mission'); // risk_rule records do not pollute operational hints
    expect(hints).not.toContain(`source_ref: ${queued.candidate_id}`);
    expect(queued?.evidence_refs).toContain(
      path
        .relative(pathResolver.rootDir(), path.join(missionPath, 'evidence', wisdomFileName))
        .replace(/\\/g, '/')
    );
  });

  it('rejects a directory replacing the evidence ledger before distillation reads it', () => {
    safeMkdir(`${missionPath}/evidence/ledger.jsonl`, { recursive: true });

    expect(() => gatherDistillContext(missionId, loadState(missionId)!, missionPath)).toThrow(
      '[MISSION_DISTILL_RESOURCE] evidence ledger must be a regular file'
    );
  });

  it('replays a persisted failed enqueue after completion without running the LLM again', async () => {
    const enqueue = vi.spyOn(memoryQueue, 'enqueueMemoryPromotionCandidate');
    enqueue.mockImplementationOnce(() => {
      throw new Error('queue unavailable');
    });
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'ecosystem_architect';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    try {
      await distillMission(missionId, pathResolver.rootDir());
      const outboxPath = `${missionPath}/evidence/memory-promotion-outbox.json`;
      const pending = readJson<{ status: string; candidate: { candidate_id: string } }>(outboxPath);
      expect(loadState(missionId)?.status).toBe('completed');
      expect(pending.status).toBe('pending');
      expect(listMemoryPromotionCandidates()).toHaveLength(0);
      const llmCalls = vi.mocked(runAdaptiveStructuredLlmProfile).mock.calls.length;

      await distillMission(missionId, pathResolver.rootDir());
      expect(readJson<{ status: string }>(outboxPath).status).toBe('delivered');
      expect(listMemoryPromotionCandidates()).toHaveLength(1);
      expect(listMemoryPromotionCandidates()[0].candidate_id).toBe(pending.candidate.candidate_id);
      expect(vi.mocked(runAdaptiveStructuredLlmProfile).mock.calls).toHaveLength(llmCalls);
      await distillMission(missionId, pathResolver.rootDir());
      expect(enqueue).toHaveBeenCalledTimes(2);
    } finally {
      enqueue.mockRestore();
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });

  it('preserves an approved candidate when delivery acknowledgement was lost', async () => {
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'ecosystem_architect';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    try {
      await distillMission(missionId, pathResolver.rootDir());
      const outboxPath = `${missionPath}/evidence/memory-promotion-outbox.json`;
      const outbox = readJson<Record<string, unknown>>(outboxPath);
      const queued = listMemoryPromotionCandidates()[0];
      updateMemoryPromotionCandidateStatus({
        candidateId: queued.candidate_id,
        status: 'approved',
        knowledgeDomain: 'organization',
        ratificationNote: 'Approved before replay',
        curation: {
          title: 'Durable lesson',
          summary: 'Curated lesson',
          content: 'Keep this approved content.',
          evidence_refs: queued.evidence_refs,
        },
      });
      const approved = listMemoryPromotionCandidates()[0];
      writeJson(outboxPath, { ...outbox, status: 'pending' });
      await distillMission(missionId, pathResolver.rootDir());
      expect(listMemoryPromotionCandidates()).toEqual([approved]);
      expect(readJson<{ status: string }>(outboxPath).status).toBe('delivered');
    } finally {
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });

  it('recovers a physically archived mission through visible archive state and rejects mismatched scope', async () => {
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    const activePath = missionPath;
    const archiveRoot = pathResolver.shared('tmp/mission-distill-archive');
    process.env.MISSION_ROLE = 'ecosystem_architect';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    try {
      await distillMission(missionId, pathResolver.rootDir());
      let outboxPath = `${missionPath}/evidence/memory-promotion-outbox.json`;
      const outbox = readJson<{ candidate: Record<string, unknown> }>(outboxPath);
      const statePath = `${missionPath}/mission-state.json`;
      const state = readJson<Record<string, unknown>>(statePath);
      writeJson(statePath, { ...state, status: 'archived' });
      writeJson(outboxPath, { ...outbox, status: 'pending' });

      const archivedPath = path.join(archiveRoot, 'public', 'shared', missionId);
      safeMkdir(path.dirname(archivedPath), { recursive: true });
      safeMoveSync(activePath, archivedPath);
      missionPath = '';
      archiveLookupRoot = archiveRoot;
      outboxPath = `${archivedPath}/evidence/memory-promotion-outbox.json`;
      expect(safeExistsSync(activePath)).toBe(false);
      expect(loadState(missionId)).toBeNull();
      expect(pathResolver.findArchivedMissionDir(missionId)).toBe(archivedPath);
      await distillMission(missionId, pathResolver.rootDir());
      expect(loadMissionStateIncludingArchive(missionId)?.status).toBe('archived');
      expect(readJson<{ status: string }>(outboxPath).status).toBe('delivered');

      writeJson(outboxPath, {
        ...outbox,
        status: 'pending',
        candidate: {
          ...outbox.candidate,
          sensitivity_tier: 'confidential',
          ratification_required: true,
        },
      });
      await expect(distillMission(missionId, pathResolver.rootDir())).rejects.toThrow(
        'identity or scope'
      );
      expect(readJson<{ status: string }>(outboxPath).status).toBe('pending');

      writeJson(`${archivedPath}/mission-state.json`, {
        ...state,
        status: 'archived',
        tenant_slug: 'unbound-tenant',
      });
      expect(loadMissionStateIncludingArchive(missionId)).toBeNull();
      await expect(distillMission(missionId, pathResolver.rootDir())).rejects.toThrow('not found');
    } finally {
      missionPath = activePath;
      archiveLookupRoot = '';
      safeRmSync(archiveRoot, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });
});

describe('resolveWisdomOutputPath', () => {
  it('rejects output directories outside the repository root', () => {
    expect(() => resolveWisdomOutputPath('../../outside-wisdom', 'distill.md')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects a symbolic-link output directory', () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const target = pathResolver.shared(`tmp/mission-distill-output-target-${suffix}`);
    const link = pathResolver.shared(`tmp/mission-distill-output-link-${suffix}`);
    safeMkdir(target, { recursive: true });
    safeSymlinkSync(target, link);
    try {
      expect(() =>
        resolveWisdomOutputPath(
          `active/shared/tmp/mission-distill-output-link-${suffix}`,
          'distill.md'
        )
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(link, { force: true });
      safeRmSync(target, { recursive: true, force: true });
    }
  });
});

describe('WISDOM_SCHEMA harness2 experience contract', () => {
  const baseWisdom = {
    title: 'Test wisdom',
    category: 'Evolution' as const,
    tags: ['test'],
    importance: 5,
    sections: {
      summary: 'summary',
      key_learnings: ['l1'],
      patterns_discovered: ['p1'],
      failures_and_recoveries: ['None'],
      reusable_artifacts: ['None identified'],
    },
  };

  it('accepts a wisdom object without the new optional fields (backward compatible)', () => {
    expect(WISDOM_SCHEMA.safeParse(baseWisdom).success).toBe(true);
  });

  it('accepts explicit null optional lessons from structured-output providers', () => {
    expect(
      WISDOM_SCHEMA.safeParse({ ...baseWisdom, experience: null, edit_rows: null }).success
    ).toBe(true);
    expect(
      WISDOM_SCHEMA.safeParse({
        ...baseWisdom,
        experience: { cue: 'c', lesson: 'l', confidence: 'high' },
        edit_rows: null,
      }).success
    ).toBe(false);
  });

  it('accepts a complete experience block and edit rows', () => {
    const wisdom = {
      ...baseWisdom,
      experience: {
        cue: 'when a task changes several components at once',
        lesson: 'isolate component changes in separate rollout probes',
        evidence: 'edit_rows[0], edit_rows[1]',
        confidence: 'medium',
      },
      edit_rows: [
        {
          component: 'scripts/check_totals.py',
          change: 'added a deterministic totals checker',
          observed: 'rollout inv1 reconciled totals without manual loop',
          verdict: 'helped',
        },
        {
          component: 'guardrails',
          change: 'rewrote completion rules while also changing skills',
          observed: 'cannot attribute the divergence to either change',
          verdict: 'confounded',
        },
      ],
    };
    expect(WISDOM_SCHEMA.safeParse(wisdom).success).toBe(true);
  });

  it('rejects a partial experience block (missing evidence)', () => {
    const wisdom = {
      ...baseWisdom,
      experience: { cue: 'cue', lesson: 'lesson', confidence: 'high' },
    };
    expect(WISDOM_SCHEMA.safeParse(wisdom).success).toBe(false);
  });

  it('rejects empty-string fields inside an experience block', () => {
    expect(
      WISDOM_SCHEMA.safeParse({
        ...baseWisdom,
        experience: { cue: 'c', lesson: 'l', evidence: '', confidence: 'high' },
      }).success
    ).toBe(false);
  });

  it('rejects a verdict outside the enum', () => {
    const wisdom = {
      ...baseWisdom,
      edit_rows: [{ component: 'c', change: 'x', observed: 'y', verdict: 'probably_helped' }],
    };
    expect(WISDOM_SCHEMA.safeParse(wisdom).success).toBe(false);
  });
});

describe('formatWisdomMarkdown experience rendering', () => {
  const baseWisdom = {
    title: 'Render Test',
    category: 'Operations',
    tags: ['t'],
    importance: 3,
    sections: {
      summary: 's',
      key_learnings: [],
      patterns_discovered: [],
      failures_and_recoveries: ['None'],
      reusable_artifacts: ['None identified'],
    },
  };

  it('renders change-attribution rows and the transferable lesson when present', () => {
    const md = formatWisdomMarkdown(
      {
        ...baseWisdom,
        edit_rows: [
          {
            component: 'skills/doc_review',
            change: 'added a trigger line',
            observed: 'rollout dom1 invoked the skill',
            verdict: 'helped',
          },
        ],
        experience: {
          cue: 'document-review tasks',
          lesson: 'name the trigger in always-on text',
          evidence: 'edit_rows[0]',
          confidence: 'high',
        },
      },
      'MSN-RENDER-1'
    );
    expect(md).toContain('What Each Change Did');
    expect(md).toContain('**skills/doc_review** (helped)');
    expect(md).toContain('Transferable Lesson');
    expect(md).toContain('**cue**: document-review tasks');
    expect(md).toContain('**confidence**: high');
  });

  it('omits both sections when the fields are absent', () => {
    const md = formatWisdomMarkdown(baseWisdom, 'MSN-RENDER-2');
    expect(md).not.toContain('What Each Change Did');
    expect(md).not.toContain('Transferable Lesson');
  });
});
