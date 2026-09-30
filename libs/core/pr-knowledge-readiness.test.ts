import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  checkPrKnowledgeReadiness,
  evaluatePrKnowledgeReadiness,
  listChangedFiles,
  parsePrBodyKnowledge,
  readMissionMemoryCandidates,
  readMissionMemoryCandidatesFromRoot,
  resolveMissionRoot,
  type GitRunner,
} from './knowledge/pr-knowledge-readiness.js';
import type { MemoryCandidate } from './knowledge/memory-promotion-queue.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
} from './knowledge/memory-promotion-queue.js';

const CORE_DIST_BUILT = safeExistsSync(pathResolver.rootResolve('libs/core/dist/secure-io.js'));

function baseCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    candidate_id: overrides.candidate_id || 'MEM-KL03-TEST',
    source_type: 'mission',
    source_ref: 'mission:MSN-KL03-TEST',
    proposed_memory_kind: 'heuristic',
    summary: 'A reusable lesson captured for the knowledge readiness check.',
    evidence_refs: ['active/missions/public/MSN-KL03-TEST/evidence/notes.md'],
    sensitivity_tier: 'public',
    ratification_required: false,
    status: 'queued',
    queued_at: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

const KNOWLEDGE_SECTION_TEMPLATE = (lines: string): string =>
  [
    '## Summary',
    '',
    'Something changed.',
    '',
    '## Coordination',
    '',
    '- Mission ID: MSN-KL03-TEST',
    '- Workitem IDs:',
    '',
    '## Knowledge',
    '',
    lines,
    '',
    '## Type',
    '',
    '- [ ] feat',
  ].join('\n');

describe('parsePrBodyKnowledge', () => {
  it('extracts the mission id and treats a placeholder as absent', () => {
    expect(
      parsePrBodyKnowledge(KNOWLEDGE_SECTION_TEMPLATE('none — nothing learned')).missionId
    ).toBe('MSN-KL03-TEST');
    const noMission = [
      '## Coordination',
      '- Mission ID:',
      '## Knowledge',
      'none — no mission for this PR',
    ].join('\n');
    expect(parsePrBodyKnowledge(noMission).missionId).toBeUndefined();
  });

  it('reports hasKnowledgeSection: false when the section is absent', () => {
    const parsed = parsePrBodyKnowledge('## Summary\n\nJust a fix.\n');
    expect(parsed.hasKnowledgeSection).toBe(false);
    expect(parsed.knowledgeLines).toEqual([]);
  });

  it('parses promoted/rejected/routed/none lines', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE(
      [
        '- promoted: MEM-A → knowledge/public/generated/MEM-A.md',
        '- rejected: MEM-B — duplicate of an existing SOP',
        '- routed: MEM-C → organization',
        '- routed: MEM-D → personal',
      ].join('\n')
    );
    const parsed = parsePrBodyKnowledge(body);
    expect(parsed.hasKnowledgeSection).toBe(true);
    expect(parsed.knowledgeLines).toEqual([
      {
        kind: 'promoted',
        candidateId: 'MEM-A',
        path: 'knowledge/public/generated/MEM-A.md',
        raw: '- promoted: MEM-A → knowledge/public/generated/MEM-A.md',
      },
      {
        kind: 'rejected',
        candidateId: 'MEM-B',
        reason: 'duplicate of an existing SOP',
        raw: '- rejected: MEM-B — duplicate of an existing SOP',
      },
      {
        kind: 'routed',
        candidateId: 'MEM-C',
        domain: 'organization',
        raw: '- routed: MEM-C → organization',
      },
      {
        kind: 'routed',
        candidateId: 'MEM-D',
        domain: 'personal',
        raw: '- routed: MEM-D → personal',
      },
    ]);
  });

  it('ignores unedited template placeholder lines (e.g. "promoted: <candidate_id> → <path>")', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE(
      [
        '- promoted: <candidate_id> → <path>',
        '- rejected: <candidate_id> — <reason>',
        '- routed: <candidate_id> → organization|personal',
        '- none — <reason>',
      ].join('\n')
    );
    const parsed = parsePrBodyKnowledge(body);
    expect(parsed.hasKnowledgeSection).toBe(true);
    expect(parsed.knowledgeLines).toEqual([]);
  });
});

describe('evaluatePrKnowledgeReadiness', () => {
  it('flags missing_knowledge_section when the body has no Knowledge heading', () => {
    const result = evaluatePrKnowledgeReadiness({
      body: '## Coordination\n- Mission ID:\n',
      candidates: [],
      changedFiles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(['missing_knowledge_section']);
  });

  it('passes a no-mission PR that declares "none — reason"', () => {
    const body = ['## Coordination', '- Mission ID:', '## Knowledge', 'none — no learnings'].join(
      '\n'
    );
    const result = evaluatePrKnowledgeReadiness({ body, candidates: [], changedFiles: [] });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('flags tier_leak for any confidential/personal changed file, mission or not', () => {
    const body = ['## Coordination', '- Mission ID:', '## Knowledge', 'none — n/a'].join('\n');
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [],
      changedFiles: ['knowledge/confidential/acme/secret.md', 'knowledge/personal/me/note.md'],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        code: 'tier_leak',
        message: expect.stringContaining('knowledge/confidential/acme/secret.md'),
      },
      {
        code: 'tier_leak',
        message: expect.stringContaining('knowledge/personal/me/note.md'),
      },
    ]);
  });

  it('flags no_mission_candidates when the mission has none in the queue', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('none — n/a');
    const result = evaluatePrKnowledgeReadiness({ body, candidates: [], changedFiles: [] });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { code: 'no_mission_candidates', message: expect.stringContaining('MSN-KL03-TEST') },
    ]);
  });

  it('flags unresolved_candidate for a queued/approved product or unclassified candidate', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('promoted: MEM-Q → knowledge/public/x.md');
    const queued = baseCandidate({ candidate_id: 'MEM-Q', status: 'queued' });
    const approved = baseCandidate({
      candidate_id: 'MEM-A',
      status: 'approved',
      knowledge_domain: 'unclassified',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [queued, approved],
      changedFiles: [],
    });
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain('unresolved_candidate');
    expect(result.violations.filter((v) => v.code === 'unresolved_candidate')).toHaveLength(2);
  });

  it('flags promoted_record_not_in_diff for a promoted product candidate absent from the diff', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE(
      'promoted: MEM-P → knowledge/public/generated/MEM-P.md'
    );
    const candidate = baseCandidate({
      candidate_id: 'MEM-P',
      status: 'promoted',
      knowledge_domain: 'product',
      promoted_ref: 'knowledge/public/generated/MEM-P.md',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { code: 'promoted_record_not_in_diff', message: expect.stringContaining('MEM-P') },
    ]);
  });

  it('flags candidate_not_declared when the id is absent from the Knowledge section', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('none — n/a');
    const candidate = baseCandidate({
      candidate_id: 'MEM-UNDECLARED',
      status: 'rejected',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { code: 'candidate_not_declared', message: expect.stringContaining('MEM-UNDECLARED') },
    ]);
  });

  it('passes a promoted + declared product candidate whose record is in the diff', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE(
      'promoted: MEM-P → knowledge/public/generated/MEM-P.md'
    );
    const candidate = baseCandidate({
      candidate_id: 'MEM-P',
      status: 'promoted',
      knowledge_domain: 'product',
      promoted_ref: 'knowledge/public/generated/MEM-P.md',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: ['knowledge/public/generated/MEM-P.md'],
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('passes a rejected + declared candidate', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('rejected: MEM-R — duplicate of an existing SOP');
    const candidate = baseCandidate({ candidate_id: 'MEM-R', status: 'rejected' });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: [],
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('passes a routed-to-organization + declared candidate without requiring it be promoted', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('routed: MEM-ORG → organization');
    const candidate = baseCandidate({
      candidate_id: 'MEM-ORG',
      status: 'approved',
      knowledge_domain: 'organization',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: [],
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });
});

describe('resolveMissionRoot', () => {
  let base: string;

  beforeEach(() => {
    base = pathResolver.sharedTmp(`vitest-kl03-mission-root/${randomUUID()}`);
  });

  afterEach(() => {
    safeRmSync(base, { recursive: true, force: true });
  });

  it('returns the explicit root outright', () => {
    expect(resolveMissionRoot({ explicitRoot: '/some/explicit/root', cwdRoot: base })).toBe(
      path.resolve('/some/explicit/root')
    );
  });

  it('returns cwdRoot when it already has mission records', () => {
    safeMkdir(path.join(base, 'active/missions/MSN-X'), { recursive: true });
    expect(resolveMissionRoot({ cwdRoot: base })).toBe(path.resolve(base));
  });

  it('falls back to the main worktree reported by git when cwdRoot has no records', () => {
    const gitRunner: GitRunner = (args) => {
      expect(args).toEqual(['worktree', 'list', '--porcelain']);
      return {
        status: 0,
        stdout: ['worktree /main/checkout', 'HEAD abc123', '', 'worktree /feature/worktree'].join(
          '\n'
        ),
        stderr: '',
      };
    };
    expect(resolveMissionRoot({ cwdRoot: base, gitRunner })).toBe(path.resolve('/main/checkout'));
  });

  it('falls back to cwdRoot when git has no worktree output', () => {
    const gitRunner: GitRunner = () => ({ status: 0, stdout: '', stderr: '' });
    expect(resolveMissionRoot({ cwdRoot: base, gitRunner })).toBe(path.resolve(base));
  });
});

describe('listChangedFiles', () => {
  it('parses git diff --name-only output', () => {
    const gitRunner: GitRunner = (args, cwd) => {
      expect(args).toEqual(['diff', '--name-only', 'origin/main...HEAD']);
      expect(cwd).toBe('/repo');
      return { status: 0, stdout: 'a.ts\nb.ts\n\n', stderr: '' };
    };
    expect(listChangedFiles({ repoRoot: '/repo', gitRunner })).toEqual(['a.ts', 'b.ts']);
  });

  it('respects an explicit base', () => {
    const gitRunner: GitRunner = (args) => {
      expect(args).toEqual(['diff', '--name-only', 'main...HEAD']);
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(listChangedFiles({ repoRoot: '/repo', base: 'main', gitRunner })).toEqual([]);
  });

  it('throws when git fails', () => {
    const gitRunner: GitRunner = () => ({ status: 128, stdout: '', stderr: 'fatal: bad revision' });
    expect(() => listChangedFiles({ repoRoot: '/repo', gitRunner })).toThrow(/bad revision/);
  });
});

describe('readMissionMemoryCandidates', () => {
  const originalQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
  let base: string;

  beforeEach(() => {
    base = pathResolver.sharedTmp(`vitest-kl03-candidates/${randomUUID()}`);
    process.env.KYBERION_MEMORY_QUEUE_PATH = path.relative(
      pathResolver.rootDir(),
      path.join(base, 'promotion-queue.jsonl')
    );
  });

  afterEach(() => {
    if (originalQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
    else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueuePath;
    safeRmSync(base, { recursive: true, force: true });
  });

  it('takes the in-process fast path when the mission root is the current root', () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-SAME-ROOT',
      sourceType: 'mission',
      sourceRef: 'mission:MSN-SAME-ROOT',
      proposedMemoryKind: 'heuristic',
      summary: 'Same-root fast path candidate for the knowledge readiness reader.',
      evidenceRefs: ['active/missions/public/MSN-SAME-ROOT/evidence/notes.md'],
      sensitivityTier: 'public',
    });
    enqueueMemoryPromotionCandidate(candidate);
    const root = pathResolver.rootDir();
    const result = readMissionMemoryCandidates(root, root);
    expect(result).toEqual(listMemoryPromotionCandidates());
    expect(result.some((row) => row.candidate_id === 'MEM-SAME-ROOT')).toBe(true);
  });

  it('delegates to the injected reader for a different mission root', () => {
    const fakeCandidates = [baseCandidate({ candidate_id: 'MEM-INJECTED' })];
    const reader = (root: string) => {
      expect(root).toBe(path.resolve('/other/worktree'));
      return fakeCandidates;
    };
    const result = readMissionMemoryCandidates('/other/worktree', pathResolver.rootDir(), reader);
    expect(result).toBe(fakeCandidates);
  });
});

describe.skipIf(!CORE_DIST_BUILT)(
  'readMissionMemoryCandidatesFromRoot (cross-worktree, real child process)',
  () => {
    let root: string;

    beforeEach(() => {
      root = pathResolver.sharedTmp(`vitest-kl03-cross-root/${randomUUID()}`);
      safeMkdir(path.join(root, 'knowledge'), { recursive: true });
      safeMkdir(path.join(root, 'active/shared/runtime/memory'), { recursive: true });
      safeWriteFile(path.join(root, 'package.json'), '{"name":"kl03-fixture","private":true}\n');
      safeWriteFile(path.join(root, 'AGENTS.md'), '# fixture\n');
      const row: MemoryCandidate = baseCandidate({
        candidate_id: 'MEM-CROSS-ROOT',
        source_ref: 'mission:MSN-CROSS-ROOT',
      });
      safeWriteFile(
        path.join(root, 'active/shared/runtime/memory/promotion-queue.jsonl'),
        `${JSON.stringify(row)}\n`
      );
    });

    afterEach(() => {
      safeRmSync(root, { recursive: true, force: true });
    });

    it('reads candidates from a different project root through a governed child process', () => {
      const candidates = readMissionMemoryCandidatesFromRoot(root);
      expect(candidates.map((row) => row.candidate_id)).toEqual(['MEM-CROSS-ROOT']);
    }, 30_000);
  }
);

describe('checkPrKnowledgeReadiness (wiring)', () => {
  it('composes resolution, reading, diffing and evaluation', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('rejected: MEM-WIRED — not reusable');
    const gitRunner: GitRunner = (args) => {
      if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = checkPrKnowledgeReadiness({
      body,
      repoRoot: '/repo',
      missionRootInput: { explicitRoot: '/repo', cwdRoot: '/repo' },
      gitRunner,
      candidateReader: () => [baseCandidate({ candidate_id: 'MEM-WIRED', status: 'rejected' })],
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });
});
