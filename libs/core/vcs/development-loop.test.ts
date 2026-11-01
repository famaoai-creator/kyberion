import { describe, it, expect, vi } from 'vitest';
import { reconcileVcsDevelopment, type DevelopmentLoopPorts } from './development-loop.js';
import type { VcsDevelopmentPr } from './development-proof.js';
const pr: VcsDevelopmentPr = {
  repository: 'https://github.com/o/r',
  number: 1,
  url: 'https://github.com/o/r/pull/1',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  headBranch: 'agent/kyberion-development',
  baseBranch: 'main',
  state: 'open',
  draft: false,
};
function fixture(): DevelopmentLoopPorts {
  return {
    verifyMerged: vi.fn(() => ({
      state: 'success',
      policyDigest: 'policy',
      requiredChecks: ['CI'],
      reasons: [],
    })),
    snapshot: vi.fn(() => ({ ...pr })),
    ci: vi.fn(() => ({
      state: 'success',
      policyDigest: 'policy',
      requiredChecks: ['CI'],
      reasons: [],
    })),
    review: vi.fn(() => ({ ok: true, reviewedBaseSha: pr.baseSha })),
    promote: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  };
}
describe('prepared development reconciliation', () => {
  it('defaults to mutation-free preflight', () => {
    const p = fixture();
    expect(reconcileVcsDevelopment(p).status).toBe('ready');
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('pending checks do not trigger repairs or review', () => {
    const p = fixture();
    p.ci = () => ({ state: 'pending', policyDigest: 'p', requiredChecks: ['CI'], reasons: [] });
    expect(reconcileVcsDevelopment(p, false).status).toBe('waiting');
    expect(p.review).not.toHaveBeenCalled();
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('failed checks require the existing executor', () => {
    const p = fixture();
    p.ci = () => ({ state: 'failure', policyDigest: 'p', requiredChecks: ['CI'], reasons: [] });
    expect(reconcileVcsDevelopment(p, false).status).toBe('repair_required');
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('does not promote without independent review', () => {
    const p = fixture();
    p.review = () => ({ ok: false });
    expect(reconcileVcsDevelopment(p, false).status).toBe('review_required');
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('invalidates proof after a concurrent head change', () => {
    const p = fixture();
    let n = 0;
    p.snapshot = () => ({ ...pr, headSha: ++n === 1 ? pr.headSha : 'c'.repeat(40) });
    expect(reconcileVcsDevelopment(p, false).status).toBe('review_required');
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('invalidates proof after server policy changes', () => {
    const p = fixture();
    let n = 0;
    p.ci = () => ({
      state: 'success',
      policyDigest: String(++n),
      requiredChecks: ['CI'],
      reasons: [],
    });
    expect(reconcileVcsDevelopment(p, false).status).toBe('blocked');
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('successful merge command only means queued until remote merged', () => {
    const p = fixture();
    expect(reconcileVcsDevelopment(p, false).status).toBe('queued');
    expect(p.promote).toHaveBeenCalledOnce();
  });
  it('verifies immutable remote merge commit after promotion', () => {
    const p = fixture();
    let n = 0;
    p.snapshot = () =>
      ++n < 3 ? { ...pr } : { ...pr, state: 'merged', mergeCommitSha: 'd'.repeat(40) };
    expect(reconcileVcsDevelopment(p, false).status).toBe('merged');
  });
  it('resumes a merged PR without a repeated mutation', () => {
    const p = fixture();
    p.snapshot = () => ({ ...pr, state: 'merged', mergeCommitSha: 'd'.repeat(40) });
    expect(reconcileVcsDevelopment(p, false).status).toBe('merged');
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('blocks ambiguous CI and wrong branch rather than weakening policy', () => {
    const p = fixture();
    p.snapshot = () => ({ ...pr, headBranch: 'attacker' });
    expect(reconcileVcsDevelopment(p, false).status).toBe('blocked');
    expect(p.promote).not.toHaveBeenCalled();
  });
});

describe('immutable post-merge verification', () => {
  it.each(['pending', 'failure', 'unverified'] as const)(
    'retains merge receipt when CI is %s',
    (state) => {
      const p = fixture();
      p.snapshot = () => ({ ...pr, state: 'merged', mergeCommitSha: 'e'.repeat(40) });
      p.verifyMerged = () => ({
        state,
        policyDigest: 'policy',
        requiredChecks: ['CI'],
        reasons: [],
      });
      const r = reconcileVcsDevelopment(p, false);
      expect(r.status).toBe(
        state === 'pending'
          ? 'post_merge_waiting'
          : state === 'failure'
            ? 'post_merge_failed'
            : 'post_merge_unverified'
      );
      expect(r.knownMergeCommitSha).toBe('e'.repeat(40));
      expect(p.promote).not.toHaveBeenCalled();
    }
  );
  it('missing verification adapter never completes the WorkItem', () => {
    const p = fixture();
    p.snapshot = () => ({ ...pr, state: 'merged', mergeCommitSha: 'e'.repeat(40) });
    delete p.verifyMerged;
    expect(reconcileVcsDevelopment(p, false).status).toBe('post_merge_unverified');
  });
});

describe('live promotion lineage', () => {
  it('rechecks review after fresh CI before mutation', () => {
    const p = fixture();
    let reviewed = true,
      n = 0;
    p.ci = () => {
      if (++n === 2) reviewed = false;
      return { state: 'success', policyDigest: 'policy', requiredChecks: ['CI'], reasons: [] };
    };
    p.review = () => ({ ok: reviewed });
    expect(reconcileVcsDevelopment(p, false).status).toBe('review_required');
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('does not reenqueue an already queued PR', () => {
    const p = fixture();
    p.snapshot = () => ({ ...pr, queued: true });
    expect(reconcileVcsDevelopment(p, false).status).toBe('queued');
    expect(p.promote).not.toHaveBeenCalled();
  });
  it('merged resume still requires original WorkItem review', () => {
    const p = fixture();
    p.snapshot = () => ({ ...pr, state: 'merged', mergeCommitSha: 'e'.repeat(40) });
    p.review = () => ({ ok: false });
    const r = reconcileVcsDevelopment(p, false);
    expect(r.status).toBe('review_required');
    expect(r.knownMergeCommitSha).toBe('e'.repeat(40));
  });
  it('merged wrong branch never completes', () => {
    const p = fixture();
    p.snapshot = () => ({
      ...pr,
      headBranch: 'attacker',
      state: 'merged',
      mergeCommitSha: 'e'.repeat(40),
    });
    expect(reconcileVcsDevelopment(p, false).status).toBe('blocked');
  });
});

import { createHash } from 'node:crypto';
import { readReviewedDevelopmentManifest } from './development-loop.js';
describe('review manifest immutable snapshot', () => {
  it('does not reread a mutable path between hash and parse', () => {
    const reviewed = Buffer.from('{"head_sha":"reviewed"}'),
      replacement = Buffer.from('{"head_sha":"unreviewed"}');
    const read = vi.fn().mockReturnValueOnce(reviewed).mockReturnValue(replacement);
    const digest = createHash('sha256').update(reviewed).digest('hex');
    expect(readReviewedDevelopmentManifest('manifest.json', digest, read).head_sha).toBe(
      'reviewed'
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched snapshot even if subsequent path reads would match', () => {
    const reviewed = Buffer.from('{"head_sha":"reviewed"}'),
      replacement = Buffer.from('{"head_sha":"unreviewed"}');
    const read = vi.fn().mockReturnValueOnce(replacement).mockReturnValue(reviewed);
    expect(() =>
      readReviewedDevelopmentManifest(
        'manifest.json',
        createHash('sha256').update(reviewed).digest('hex'),
        read
      )
    ).toThrow('Reviewed manifest changed');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('post-merge reviewed baseline transport', () => {
  it('uses reviewed original base instead of current PR base', () => {
    const p = fixture();
    p.snapshot = () => ({
      ...pr,
      state: 'merged',
      baseSha: 'e'.repeat(40),
      mergeCommitSha: 'e'.repeat(40),
    });
    const verify = vi.fn((_revision: VcsDevelopmentPr) => ({
      state: 'success' as const,
      policyDigest: 'policy',
      requiredChecks: ['CI'],
      reasons: [],
    }));
    p.verifyMerged = verify;
    expect(reconcileVcsDevelopment(p, false).status).toBe('merged');
    expect(verify.mock.calls[0]?.[0]).toMatchObject({ baseSha: pr.baseSha });
  });
  it('cannot complete without established reviewed baseline', () => {
    const p = fixture();
    p.snapshot = () => ({ ...pr, state: 'merged', mergeCommitSha: 'e'.repeat(40) });
    p.review = () => ({ ok: true });
    expect(reconcileVcsDevelopment(p, false).status).toBe('post_merge_unverified');
  });
});

describe('post-merge reviewed CI policy continuity', () => {
  it.each(['different-policy', ''])(
    'retains merge receipt without completing under %j policy',
    (policyDigest) => {
      const p = fixture();
      p.snapshot = () => ({ ...pr, state: 'merged', mergeCommitSha: 'e'.repeat(40) });
      p.verifyMerged = () => ({
        state: 'success',
        policyDigest,
        requiredChecks: ['CI'],
        reasons: [],
      });
      const r = reconcileVcsDevelopment(p, false);
      expect(r.status).toBe('post_merge_unverified');
      expect(r.knownMergeCommitSha).toBe('e'.repeat(40));
      expect(p.promote).not.toHaveBeenCalled();
    }
  );
  it('requires nonempty reviewed policy even if postmerge policy is equally empty', () => {
    const p = fixture();
    p.snapshot = () => ({ ...pr, state: 'merged', mergeCommitSha: 'e'.repeat(40) });
    p.ci = () => ({ state: 'success', policyDigest: '', requiredChecks: ['CI'], reasons: [] });
    p.verifyMerged = p.ci;
    expect(reconcileVcsDevelopment(p, false).status).toBe('post_merge_unverified');
  });
});
