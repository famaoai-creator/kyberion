import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  checkPrKnowledgeReadiness,
  evaluatePrKnowledgeReadiness,
  listChangedFiles,
  parsePrBodyKnowledge,
  readMissionMemoryCandidates,
  readMissionMemoryCandidatesFromRoot,
  resolveMissionRoot,
  type ChangedFile,
  type GitRunner,
} from './pr-knowledge-readiness.js';
import type { MemoryCandidate } from './memory-promotion-queue.js';
import type { MemoryScopeEnvelope } from './memory-scope.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
} from './memory-promotion-queue.js';

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

function changed(status: string, filePath: string): ChangedFile {
  return { status, path: filePath };
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

  it('normalizes a backticked/quoted/lowercase Mission ID', () => {
    const body = [
      '## Coordination',
      '- Mission ID: `msn-kl03-test`',
      '## Knowledge',
      'none — n/a',
    ].join('\n');
    expect(parsePrBodyKnowledge(body).missionId).toBe('MSN-KL03-TEST');
  });

  it('treats an unterminated comment as hiding the rest and stays linear on many openers', () => {
    const hidden = parsePrBodyKnowledge(
      ['## Knowledge', '', '<!-- unterminated', '- none — hidden reason'].join('\n')
    );
    expect(hidden.knowledgeLines).toEqual([]);
    const started = Date.now();
    parsePrBodyKnowledge(`## Knowledge\n${'<!--'.repeat(50_000)}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('strips HTML comments (including multi-line ones) before parsing', () => {
    const body = [
      '## Coordination',
      '<!-- Fill these in when the change is part of a mission/workitem flow. -->',
      '- Mission ID: MSN-KL03-TEST',
      '## Knowledge',
      '<!--',
      'multi-line instructions',
      '- promoted: <candidate_id> → <path>',
      '-->',
      '- rejected: MEM-R — duplicate of an existing SOP',
    ].join('\n');
    const parsed = parsePrBodyKnowledge(body);
    expect(parsed.missionId).toBe('MSN-KL03-TEST');
    expect(parsed.knowledgeLines).toEqual([
      {
        kind: 'rejected',
        candidateId: 'MEM-R',
        reason: 'duplicate of an existing SOP',
        raw: '- rejected: MEM-R — duplicate of an existing SOP',
      },
    ]);
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

  it('flags knowledge_section_empty for an unedited template (only placeholder lines) even with no mission', () => {
    const body = [
      '## Coordination',
      '- Mission ID:',
      '## Knowledge',
      '- promoted: <candidate_id> → <path>',
      '- none — <reason>',
    ].join('\n');
    const result = evaluatePrKnowledgeReadiness({ body, candidates: [], changedFiles: [] });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { code: 'knowledge_section_empty', message: expect.any(String) },
    ]);
  });

  it('flags knowledge_section_empty for a no-mission PR that has content but no "none" line', () => {
    const body = [
      '## Coordination',
      '- Mission ID:',
      '## Knowledge',
      'rejected: MEM-X — obsolete',
    ].join('\n');
    const result = evaluatePrKnowledgeReadiness({ body, candidates: [], changedFiles: [] });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { code: 'knowledge_section_empty', message: expect.stringContaining('non-empty reason') },
    ]);
  });

  it('passes a no-mission PR that declares "none — reason"', () => {
    const body = ['## Coordination', '- Mission ID:', '## Knowledge', 'none — no learnings'].join(
      '\n'
    );
    const result = evaluatePrKnowledgeReadiness({ body, candidates: [], changedFiles: [] });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('flags tier_leak only for an ADDED confidential/personal file, mission or not', () => {
    const body = ['## Coordination', '- Mission ID:', '## Knowledge', 'none — n/a'].join('\n');
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [],
      changedFiles: [
        changed('A', 'knowledge/confidential/acme/secret.md'),
        changed('A', 'knowledge/personal/me/note.md'),
      ],
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

  it('does not flag tier_leak for a MODIFIED or DELETED file already tracked under a knowledge tier (e.g. the .gitignore-negated files)', () => {
    const body = ['## Coordination', '- Mission ID:', '## Knowledge', 'none — n/a'].join('\n');
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [],
      changedFiles: [
        changed('M', 'knowledge/personal/README.md'),
        changed('D', 'knowledge/personal/voice/config.json'),
        changed('M', 'knowledge/confidential/acme/already-tracked.md'),
      ],
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('flags tier_leak for a non-ASCII added path under either tier, normalized case-insensitively', () => {
    const body = ['## Coordination', '- Mission ID:', '## Knowledge', 'none — n/a'].join('\n');
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [],
      changedFiles: [
        changed('A', './Knowledge/Personal/日本語.md'),
        changed('A', 'knowledge\\confidential\\acme\\秘密.md'),
      ],
    });
    expect(result.violations.map((v) => v.code)).toEqual(['tier_leak', 'tier_leak']);
  });

  it('flags no_mission_candidates when the mission has none in the queue, mentioning --mission-root', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('none — n/a');
    const result = evaluatePrKnowledgeReadiness({ body, candidates: [], changedFiles: [] });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        code: 'no_mission_candidates',
        message: expect.stringContaining('MSN-KL03-TEST'),
      },
    ]);
    expect(result.violations[0]!.message).toContain('--mission-root');
    expect(result.violations[0]!.message).toContain('mission verify');
    expect(result.violations[0]!.message).toContain('mission distill');
  });

  it('matches a mission candidate by source_ref case-insensitively and by mission:<ID>: prefix', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('rejected: MEM-R — duplicate of an existing SOP');
    const candidate = baseCandidate({
      candidate_id: 'MEM-R',
      source_ref: 'mission:msn-kl03-test:task-1',
      status: 'rejected',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: [],
    });
    expect(result).toEqual({ ok: true, violations: [] });
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

  it('flags promoted_record_not_in_diff when the .md record is in the diff but its .json companion is not', () => {
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
      changedFiles: [changed('A', 'knowledge/public/generated/MEM-P.md')],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        code: 'promoted_record_not_in_diff',
        message: expect.stringContaining('MEM-P.json'),
      },
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

  it('flags declaration_mismatch when a promoted candidate is declared as rejected', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('rejected: MEM-P — not needed after all');
    const candidate = baseCandidate({
      candidate_id: 'MEM-P',
      status: 'promoted',
      knowledge_domain: 'product',
      promoted_ref: 'knowledge/public/generated/MEM-P.md',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: [
        changed('A', 'knowledge/public/generated/MEM-P.md'),
        changed('A', 'knowledge/public/generated/MEM-P.json'),
      ],
    });
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain('declaration_mismatch');
  });

  it('accepts "rejected:" for a rejected organization candidate', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('rejected: MEM-ORG-R — nothing reusable');
    const candidate = baseCandidate({
      candidate_id: 'MEM-ORG-R',
      status: 'rejected',
      knowledge_domain: 'organization',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: [],
    });
    expect(result.violations).toEqual([]);
  });

  it('does not count a deleted .md record as present in the diff', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE(
      'promoted: MEM-DEL → knowledge/public/generated/MEM-DEL.md'
    );
    const candidate = baseCandidate({
      candidate_id: 'MEM-DEL',
      status: 'promoted',
      knowledge_domain: 'product',
      promoted_ref: 'knowledge/public/generated/MEM-DEL.md',
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [candidate],
      changedFiles: [
        changed('D', 'knowledge/public/generated/MEM-DEL.md'),
        changed('A', 'knowledge/public/generated/MEM-DEL.json'),
      ],
    });
    expect(result.violations.map((v) => v.code)).toContain('promoted_record_not_in_diff');
  });

  it('flags declaration_mismatch when a routed candidate is declared "promoted"', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE(
      'promoted: MEM-ORG → knowledge/public/generated/MEM-ORG.md'
    );
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
    expect(result.violations).toEqual([
      { code: 'declaration_mismatch', message: expect.stringContaining('MEM-ORG') },
    ]);
  });

  it('flags declaration_mismatch when a "promoted:" line\'s path does not match promoted_ref', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE(
      'promoted: MEM-P → knowledge/public/generated/WRONG-PATH.md'
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
      changedFiles: [
        changed('A', 'knowledge/public/generated/MEM-P.md'),
        changed('A', 'knowledge/public/generated/MEM-P.json'),
      ],
    });
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain('declaration_mismatch');
  });

  it('passes a promoted + declared product candidate whose record and companion json are in the diff', () => {
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
      changedFiles: [
        changed('A', 'knowledge/public/generated/MEM-P.md'),
        changed('M', 'knowledge/public/generated/MEM-P.json'),
      ],
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

  it('flags candidate_not_declared for a TENANT-scoped (organization-domain) candidate the reader returned but the PR body omits', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('none — n/a');
    const tenantCandidate = baseCandidate({
      candidate_id: 'MEM-TENANT-ORG',
      status: 'approved',
      knowledge_domain: 'organization',
      scope: { tier: 'confidential', tenant_slug: 'acme-co' } satisfies MemoryScopeEnvelope,
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [tenantCandidate],
      changedFiles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { code: 'candidate_not_declared', message: expect.stringContaining('MEM-TENANT-ORG') },
    ]);
  });

  it('passes a TENANT-scoped (organization-domain) candidate once "routed:" declares it', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('routed: MEM-TENANT-ORG → organization');
    const tenantCandidate = baseCandidate({
      candidate_id: 'MEM-TENANT-ORG',
      status: 'approved',
      knowledge_domain: 'organization',
      scope: { tier: 'confidential', tenant_slug: 'acme-co' } satisfies MemoryScopeEnvelope,
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates: [tenantCandidate],
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

  it('returns cwdRoot when it already has mission records (no Mission ID given)', () => {
    safeMkdir(path.join(base, 'active/missions/MSN-X'), { recursive: true });
    expect(resolveMissionRoot({ cwdRoot: base })).toBe(path.resolve(base));
  });

  it("returns cwdRoot when it has THIS mission's directory under active/missions/<tier>/<ID>", () => {
    safeMkdir(path.join(base, 'active/missions/public/MSN-X'), { recursive: true });
    const gitRunner: GitRunner = () => {
      throw new Error('git should not be consulted when cwdRoot already has this mission');
    };
    expect(resolveMissionRoot({ cwdRoot: base, missionId: 'MSN-X', gitRunner })).toBe(
      path.resolve(base)
    );
  });

  it('returns cwdRoot when it has THIS mission archived under active/archive/missions/<ID>', () => {
    safeMkdir(path.join(base, 'active/archive/missions/MSN-Y'), { recursive: true });
    expect(resolveMissionRoot({ cwdRoot: base, missionId: 'msn-y' })).toBe(path.resolve(base));
  });

  it("does NOT prefer cwdRoot when it only has a DIFFERENT mission's records, and falls back to the main worktree", () => {
    safeMkdir(path.join(base, 'active/missions/public/MSN-OTHER'), { recursive: true });
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
    expect(resolveMissionRoot({ cwdRoot: base, missionId: 'MSN-X', gitRunner })).toBe(
      path.resolve('/main/checkout')
    );
  });

  it("returns cwdRoot when a memory candidate's source_ref names this mission, even with no mission directory", () => {
    safeMkdir(path.join(base, 'active/shared/runtime/memory'), { recursive: true });
    safeWriteFile(
      path.join(base, 'active/shared/runtime/memory/promotion-queue.jsonl'),
      `${JSON.stringify(baseCandidate({ source_ref: 'mission:MSN-QUEUE-ONLY' }))}\n`
    );
    expect(resolveMissionRoot({ cwdRoot: base, missionId: 'msn-queue-only' })).toBe(
      path.resolve(base)
    );
  });

  it("returns cwdRoot when a TENANT-scoped queue's candidate names this mission, with no global queue file at all", () => {
    safeMkdir(path.join(base, 'active/shared/runtime/tenants/acme-co/memory'), {
      recursive: true,
    });
    safeWriteFile(
      path.join(base, 'active/shared/runtime/tenants/acme-co/memory/promotion-queue.jsonl'),
      `${JSON.stringify(
        baseCandidate({
          candidate_id: 'MEM-TENANT-ONLY',
          source_ref: 'mission:MSN-TENANT-ONLY',
        })
      )}\n`
    );
    const gitRunner: GitRunner = () => {
      throw new Error('git should not be consulted when the tenant queue already has this mission');
    };
    expect(resolveMissionRoot({ cwdRoot: base, missionId: 'msn-tenant-only', gitRunner })).toBe(
      path.resolve(base)
    );
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
  it('parses git -c core.quotePath=false diff --name-status -z output into status+path pairs', () => {
    const gitRunner: GitRunner = (args, cwd) => {
      expect(args).toEqual([
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        '--end-of-options',
        'origin/main...HEAD',
      ]);
      expect(cwd).toBe('/repo');
      return { status: 0, stdout: 'M\0a.ts\0A\0b.ts\0', stderr: '' };
    };
    expect(listChangedFiles({ repoRoot: '/repo', gitRunner })).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'A', path: 'b.ts' },
    ]);
  });

  it('respects an explicit base', () => {
    const gitRunner: GitRunner = (args) => {
      expect(args[args.length - 1]).toBe('main...HEAD');
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(listChangedFiles({ repoRoot: '/repo', base: 'main', gitRunner })).toEqual([]);
  });

  it('normalizes non-ASCII / backslash / leading-./ paths without relying on git C-quoting', () => {
    const gitRunner: GitRunner = () => ({
      status: 0,
      stdout: ['A', './knowledge/personal/日本語.md', 'M', 'a\\b.ts', ''].join('\0'),
      stderr: '',
    });
    expect(listChangedFiles({ repoRoot: '/repo', gitRunner })).toEqual([
      { status: 'A', path: 'knowledge/personal/日本語.md' },
      { status: 'M', path: 'a/b.ts' },
    ]);
  });

  it('throws when git fails', () => {
    const gitRunner: GitRunner = () => ({ status: 128, stdout: '', stderr: 'fatal: bad revision' });
    expect(() => listChangedFiles({ repoRoot: '/repo', gitRunner })).toThrow(/bad revision/);
  });

  it('refuses a base ref with a leading dash (argument-injection guard) without calling git', () => {
    const gitRunner: GitRunner = () => {
      throw new Error('git must not be invoked with an unsafe base');
    };
    expect(() =>
      listChangedFiles({ repoRoot: '/repo', base: '--upload-pack=evil', gitRunner })
    ).toThrow(/unsafe diff base/);
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

  it('de-dupes an injected reader result by candidate_id, keeping the same reference when there is nothing to drop', () => {
    const unique = [baseCandidate({ candidate_id: 'MEM-UNIQUE' })];
    expect(
      readMissionMemoryCandidates('/other/worktree', pathResolver.rootDir(), () => unique)
    ).toBe(unique);
    const duplicated = [
      baseCandidate({ candidate_id: 'MEM-DUP', status: 'rejected' }),
      baseCandidate({ candidate_id: 'MEM-DUP', status: 'promoted' }),
      baseCandidate({ candidate_id: 'MEM-OTHER' }),
    ];
    const result = readMissionMemoryCandidates(
      '/other/worktree',
      pathResolver.rootDir(),
      () => duplicated
    );
    expect(result.map((row) => row.candidate_id)).toEqual(['MEM-DUP', 'MEM-OTHER']);
    expect(result[0]).toBe(duplicated[0]);
  });
});

describe('readMissionMemoryCandidates (tenant-scoped merge, real queue paths, no override)', () => {
  const originalQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
  let tenantQueuePath: string;

  beforeEach(() => {
    // Unlike the describe block above, this one must NOT override
    // KYBERION_MEMORY_QUEUE_PATH: the override short-circuits
    // `queuePathsForAllScopes` to a single file and skips tenant queue
    // discovery entirely, which is exactly the production-path behavior
    // under test here. Only a brand-new, uniquely-named tenant queue is
    // touched — the real global queue is never written.
    delete process.env.KYBERION_MEMORY_QUEUE_PATH;
    tenantQueuePath = memoryPromotionQueuePath({
      tier: 'confidential',
      tenant_slug: `vitest-kl03-fastpath-${randomUUID().slice(0, 8)}`,
    } satisfies MemoryScopeEnvelope);
  });

  afterEach(() => {
    if (originalQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
    else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueuePath;
    safeRmSync(tenantQueuePath, { force: true });
  });

  it('merges a tenant-scoped queue candidate on the in-process fast path', () => {
    const tenantCandidateId = `MEM-TENANT-FASTPATH-${randomUUID().slice(0, 8)}`;
    safeMkdir(path.dirname(tenantQueuePath), { recursive: true });
    safeWriteFile(
      tenantQueuePath,
      `${JSON.stringify(
        baseCandidate({
          candidate_id: tenantCandidateId,
          source_ref: 'mission:MSN-KL03-TEST',
          knowledge_domain: 'organization',
        })
      )}\n`
    );
    const root = pathResolver.rootDir();
    const result = readMissionMemoryCandidates(root, root);
    expect(result.some((row) => row.candidate_id === tenantCandidateId)).toBe(true);
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

    it('also reads a TENANT-scoped queue candidate from that root, merged with the global one', () => {
      safeMkdir(path.join(root, 'active/shared/runtime/tenants/acme-co/memory'), {
        recursive: true,
      });
      const tenantRow: MemoryCandidate = baseCandidate({
        candidate_id: 'MEM-TENANT-CROSS-ROOT',
        source_ref: 'mission:MSN-CROSS-ROOT',
        knowledge_domain: 'organization',
      });
      safeWriteFile(
        path.join(root, 'active/shared/runtime/tenants/acme-co/memory/promotion-queue.jsonl'),
        `${JSON.stringify(tenantRow)}\n`
      );
      const candidates = readMissionMemoryCandidatesFromRoot(root);
      expect(candidates.map((row) => row.candidate_id).sort()).toEqual([
        'MEM-CROSS-ROOT',
        'MEM-TENANT-CROSS-ROOT',
      ]);
    }, 30_000);

    it('de-dupes a candidate_id that appears in both the global and a tenant queue file, via readMissionMemoryCandidates', () => {
      safeMkdir(path.join(root, 'active/shared/runtime/tenants/acme-co/memory'), {
        recursive: true,
      });
      const duplicateRow: MemoryCandidate = baseCandidate({
        candidate_id: 'MEM-CROSS-ROOT',
        source_ref: 'mission:MSN-CROSS-ROOT',
        knowledge_domain: 'organization',
      });
      safeWriteFile(
        path.join(root, 'active/shared/runtime/tenants/acme-co/memory/promotion-queue.jsonl'),
        `${JSON.stringify(duplicateRow)}\n`
      );
      // `readMissionMemoryCandidatesFromRoot` alone does not de-dupe (it
      // mirrors the queue's own merged listing); the de-dupe guarantee is
      // provided by the `readMissionMemoryCandidates` wrapper around it —
      // exercise that wrapper here, forcing the cross-worktree path by
      // giving it a cwdRoot different from the mission root.
      const candidates = readMissionMemoryCandidates(root, path.dirname(root));
      expect(candidates.filter((row) => row.candidate_id === 'MEM-CROSS-ROOT')).toHaveLength(1);
    }, 30_000);
  }
);

describe('checkPrKnowledgeReadiness (wiring)', () => {
  it('composes resolution, reading, diffing and evaluation', () => {
    const body = KNOWLEDGE_SECTION_TEMPLATE('rejected: MEM-WIRED — not reusable');
    const gitRunner: GitRunner = () => ({ status: 0, stdout: '', stderr: '' });
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
