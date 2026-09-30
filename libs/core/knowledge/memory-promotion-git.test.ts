import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
  updateMemoryPromotionCandidateStatus,
  type MemoryCandidate,
} from './memory-promotion-queue.js';
import {
  ratifyPrReviewedMemoryCandidates,
  readGitProvenance,
  resolvePromotionTargetRoot,
  writePromotedFilesToWorktree,
} from './memory-promotion-git.js';

let base: string;
let repo: string;
let worktree: string;
let foreign: string;
const originalQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;

function git(cwd: string, args: string[]): string {
  const result = safeExecResult('git', args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(dir: string): void {
  safeMkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Vitest']);
  git(dir, ['config', 'user.email', 'vitest@kyberion.local']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  safeWriteFile(path.join(dir, 'package.json'), '{"name":"kl-fixture","private":true}\n');
  git(dir, ['add', 'package.json']);
  git(dir, ['commit', '-q', '-m', 'seed']);
}

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-kl-git/${randomUUID()}`);
  repo = path.join(base, 'repo');
  worktree = path.join(base, 'pr-worktree');
  foreign = path.join(base, 'foreign');
  initRepo(repo);
  git(repo, ['worktree', 'add', '-q', '-b', 'agent/kl-pr', worktree]);
  initRepo(foreign);
  process.env.KYBERION_MEMORY_QUEUE_PATH = path.relative(
    pathResolver.rootDir(),
    path.join(base, 'promotion-queue.jsonl')
  );
});

afterEach(() => {
  if (originalQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
  else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueuePath;
  safeExecResult('git', ['worktree', 'prune'], { cwd: repo });
  safeRmSync(base, { recursive: true, force: true });
});

describe('resolvePromotionTargetRoot (KL-05)', () => {
  it('accepts a worktree of the same repository', () => {
    const target = resolvePromotionTargetRoot(worktree, { currentRoot: repo });
    expect(target).toEqual({ root: path.resolve(worktree), sameAsCurrent: false });
  });

  it('marks the current checkout itself as sameAsCurrent', () => {
    expect(resolvePromotionTargetRoot(repo, { currentRoot: repo }).sameAsCurrent).toBe(true);
  });

  it('rejects a checkout of a different repository', () => {
    expect(() => resolvePromotionTargetRoot(foreign, { currentRoot: repo })).toThrow(
      /different repository/
    );
  });

  it('rejects a non-git directory and a worktree subdirectory', () => {
    // Fixture dirs live inside the host checkout, so a real non-git directory
    // cannot be produced here; a failing runner stands in for `git rev-parse`.
    const outside = path.join(base, 'not-a-worktree');
    expect(() => resolvePromotionTargetRoot('', { currentRoot: repo })).toThrow(/requires a path/);
    expect(() =>
      resolvePromotionTargetRoot(outside, {
        currentRoot: repo,
        gitRunner: () => ({ status: 128, stdout: '', stderr: 'not a git repository' }),
      })
    ).toThrow(/not a git worktree/);
    const sub = path.join(worktree, 'knowledge');
    safeMkdir(sub, { recursive: true });
    safeWriteFile(path.join(sub, 'keep.md'), 'x\n');
    expect(() => resolvePromotionTargetRoot(sub, { currentRoot: repo })).toThrow(/top level/);
  });
});

describe('readGitProvenance (KL-05)', () => {
  it('reads branch and HEAD commit of the given root', () => {
    expect(readGitProvenance(worktree)).toEqual({
      source_branch: 'agent/kl-pr',
      source_commit: git(worktree, ['rev-parse', 'HEAD']),
    });
  });

  it('omits the fields when git cannot answer', () => {
    expect(
      readGitProvenance(worktree, () => ({ status: 128, stdout: '', stderr: 'fatal' }))
    ).toEqual({});
  });
});

describe('writePromotedFilesToWorktree (KL-05)', () => {
  it('refuses paths that are not repo-relative', () => {
    expect(() =>
      writePromotedFilesToWorktree({
        root: worktree,
        executionRole: 'mission_controller',
        files: [{ path: '../escape.md', content: 'x' }],
      })
    ).toThrow(/non repo-relative/);
  });

  // The sibling-worktree write runs through the built @agent/core in a child
  // process (secure-io denies writes outside the current root in-process).
  it.skipIf(!safeExistsSync(pathResolver.rootResolve('libs/core/dist/secure-io.js')))(
    'writes the files under the target worktree through a governed child process',
    () => {
      // The child enforces the TARGET checkout's governance (it fails closed
      // without policies), so give the worktree the real policy files.
      for (const file of ['agent-policies.yaml', 'security-policy.json']) {
        const target = path.join(worktree, 'knowledge/product/governance', file);
        safeMkdir(path.dirname(target), { recursive: true });
        safeWriteFile(
          target,
          safeReadFile(pathResolver.knowledge(`product/governance/${file}`), {
            encoding: 'utf8',
          }) as string
        );
      }
      const rel = 'knowledge/product/evolution/wisdom/generated/MEM-KL-TEST.md';
      writePromotedFilesToWorktree({
        root: worktree,
        executionRole: 'mission_controller',
        files: [{ path: rel, content: '# written in worktree\n' }],
      });
      expect(safeReadFile(path.join(worktree, rel), { encoding: 'utf8' })).toBe(
        '# written in worktree\n'
      );
      expect(safeExistsSync(path.join(repo, rel))).toBe(false);
    },
    60_000
  );
});

describe('ratifyPrReviewedMemoryCandidates (KL-04)', () => {
  const recordRef = 'knowledge/product/evolution/wisdom/generated/MEM-KL-MERGED.md';

  function seed(
    candidateId: string,
    sourceRef: string,
    extra: Partial<MemoryCandidate>
  ): MemoryCandidate {
    const candidate = {
      ...createMemoryPromotionCandidate({
        candidateId,
        sourceType: 'mission',
        sourceRef,
        knowledgeDomain: 'product',
        proposedMemoryKind: 'heuristic',
        summary: `Reusable product lesson for ${candidateId} and its ratification.`,
        evidenceRefs: ['active/missions/public/MSN-KL-RATIFY/evidence/notes.md'],
        sensitivityTier: 'public',
        status: 'promoted',
      }),
      ...extra,
    };
    enqueueMemoryPromotionCandidate(candidate);
    return candidate;
  }

  function mergeRecordToOriginMain(): string {
    const target = path.join(repo, recordRef);
    safeMkdir(path.dirname(target), { recursive: true });
    safeWriteFile(target, '# merged\n');
    git(repo, ['add', recordRef]);
    git(repo, ['commit', '-q', '-m', 'merge knowledge PR']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    return git(repo, ['rev-parse', 'HEAD']);
  }

  it('records ratification when the promoted record is on origin/main', () => {
    const sha = mergeRecordToOriginMain();
    seed('MEM-KL-PR', 'mission:MSN-KL-RATIFY', {
      approval_channel: 'pr_review',
      promoted_ref: recordRef,
    });
    const result = ratifyPrReviewedMemoryCandidates({
      missionId: 'msn-kl-ratify',
      repoRoot: repo,
      now: () => '2026-09-30T00:00:00.000Z',
    });
    expect(result.missing).toEqual([]);
    expect(result.target_commit).toBe(sha);
    expect(loadMemoryPromotionCandidate('MEM-KL-PR')).toMatchObject({
      status: 'promoted',
      ratified_at: '2026-09-30T00:00:00.000Z',
      ratified_commit: sha,
      ratification_target: 'origin/main',
    });
    // Idempotent on re-run: nothing left to ratify, nothing missing.
    const again = ratifyPrReviewedMemoryCandidates({ missionId: 'MSN-KL-RATIFY', repoRoot: repo });
    expect(again).toMatchObject({ ratified: [], missing: [], already_ratified: ['MEM-KL-PR'] });
  });

  it('reports missing records and approved-but-unpromoted pr_review candidates, leaving steward ones untouched', () => {
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    seed('MEM-KL-PR-MISSING', 'mission:MSN-KL-RATIFY', {
      approval_channel: 'pr_review',
      promoted_ref: 'knowledge/product/evolution/wisdom/generated/MEM-KL-DROPPED.md',
    });
    const steward = seed('MEM-KL-STEWARD', 'mission:MSN-KL-RATIFY', {
      promoted_ref: 'knowledge/product/evolution/wisdom/generated/MEM-KL-STEWARD.md',
    });
    seed('MEM-KL-PR-APPROVED', 'mission:MSN-KL-RATIFY:task-1', {
      approval_channel: 'pr_review',
      status: 'approved',
    });
    seed('MEM-KL-STEWARD-APPROVED', 'mission:MSN-KL-RATIFY', { status: 'approved' });
    const result = ratifyPrReviewedMemoryCandidates({ missionId: 'MSN-KL-RATIFY', repoRoot: repo });
    expect(result.unpromoted).toEqual(['MEM-KL-PR-APPROVED']);
    expect(result.ratified).toEqual([]);
    expect(result.missing).toEqual([
      expect.objectContaining({
        candidate_id: 'MEM-KL-PR-MISSING',
        reason: expect.stringContaining('not present at origin/main'),
      }),
    ]);
    expect(loadMemoryPromotionCandidate('MEM-KL-PR-MISSING')?.ratified_commit).toBeUndefined();
    expect(loadMemoryPromotionCandidate('MEM-KL-STEWARD')).toEqual(steward);
  });

  it('treats an absent origin/main ref as missing (no fetch is attempted)', () => {
    seed('MEM-KL-NO-REMOTE', 'mission:MSN-KL-RATIFY', {
      approval_channel: 'pr_review',
      promoted_ref: recordRef,
    });
    const calls: string[][] = [];
    const result = ratifyPrReviewedMemoryCandidates({
      missionId: 'MSN-KL-RATIFY',
      repoRoot: repo,
      gitRunner: (args, cwd) => {
        calls.push(args);
        const r = safeExecResult('git', args, { cwd });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      },
    });
    expect(result.missing[0]).toMatchObject({
      candidate_id: 'MEM-KL-NO-REMOTE',
      reason: 'origin/main is not available locally',
    });
    expect(calls.some((args) => args.includes('fetch'))).toBe(false);
  });
});

describe('approval channel on the queue (KL-04)', () => {
  function queued(candidateId: string, knowledgeDomain: 'product' | 'organization') {
    const candidate = createMemoryPromotionCandidate({
      candidateId,
      sourceType: 'artifact',
      sourceRef: `artifact:${candidateId}`,
      knowledgeDomain,
      proposedMemoryKind: 'heuristic',
      summary: `Approval channel fixture ${candidateId} for the queue.`,
      evidenceRefs: ['knowledge/public/fixture.md'],
      sensitivityTier: 'public',
    });
    enqueueMemoryPromotionCandidate(candidate);
  }

  it('persists pr_review and defers ratified_at to the merge', () => {
    queued('MEM-KL-APPROVE-PR', 'product');
    const updated = updateMemoryPromotionCandidateStatus({
      candidateId: 'MEM-KL-APPROVE-PR',
      status: 'approved',
      approvalChannel: 'pr_review',
    });
    expect(updated?.approval_channel).toBe('pr_review');
    expect(updated?.ratified_at).toBeUndefined();
    const promoted = updateMemoryPromotionCandidateStatus({
      candidateId: 'MEM-KL-APPROVE-PR',
      status: 'promoted',
      promotedRef: 'knowledge/product/evolution/wisdom/generated/MEM-KL-APPROVE-PR.md',
    });
    expect(promoted?.approval_channel).toBe('pr_review');
    expect(promoted?.ratified_at).toBeUndefined();
  });

  it('keeps steward behaviour (ratified at approval)', () => {
    queued('MEM-KL-APPROVE-STEWARD', 'product');
    const updated = updateMemoryPromotionCandidateStatus({
      candidateId: 'MEM-KL-APPROVE-STEWARD',
      status: 'approved',
      approvalChannel: 'steward',
    });
    expect(updated?.approval_channel).toBe('steward');
    expect(updated?.ratified_at).toBeTruthy();
  });

  it('rejects unknown channels and pr_review outside product knowledge', () => {
    queued('MEM-KL-APPROVE-BAD', 'product');
    expect(() =>
      updateMemoryPromotionCandidateStatus({
        candidateId: 'MEM-KL-APPROVE-BAD',
        status: 'approved',
        approvalChannel: 'merge_bot' as never,
      })
    ).toThrow(/Unknown approval channel/);
    queued('MEM-KL-APPROVE-ORG', 'organization');
    expect(() =>
      updateMemoryPromotionCandidateStatus({
        candidateId: 'MEM-KL-APPROVE-ORG',
        status: 'approved',
        approvalChannel: 'pr_review',
      })
    ).toThrow(/only available for product knowledge/);
    expect(loadMemoryPromotionCandidate('MEM-KL-APPROVE-ORG')?.status).toBe('queued');
  });
});
