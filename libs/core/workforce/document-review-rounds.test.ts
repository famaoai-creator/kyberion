import { describe, expect, it } from 'vitest';
import {
  documentReviewFindingId,
  evaluateDocumentReviewRounds,
  type DocumentReviewRound,
  type DocumentReviewRoundFinding,
  type DocumentReviewResolution,
} from './document-review-rounds.js';

const HASH = 'a'.repeat(64);
const NEXT_HASH = 'b'.repeat(64);
const issue: DocumentReviewRoundFinding = {
  severity: 'blocking',
  category: 'comprehension',
  description: 'Missing failure semantics',
  semantic_scope: 'delivery/failure',
  issue_key: 'undefined-retry',
  location: 'line 8',
};
const identity = {
  reviewer: 'comprehension',
  semantic_scope: issue.semantic_scope,
  issue_key: issue.issue_key,
};
const id = documentReviewFindingId(identity);
const round = (
  n: number,
  findings: DocumentReviewRoundFinding[] = [],
  sha = HASH
): DocumentReviewRound => ({
  round: n,
  artifact_sha256: sha,
  reviewers: [{ reviewer: 'comprehension', status: 'completed', artifact_sha256: sha, findings }],
});
const resolution = (
  disposition: DocumentReviewResolution['disposition']
): DocumentReviewResolution => ({
  finding_id: id,
  artifact_sha256: HASH,
  semantic_scope: issue.semantic_scope,
  after_round: 1,
  disposition,
  evidence_refs: ['evidence/refutation.json'],
  ...(disposition === 'fixed' ? { fix_id: 'fix-1' } : {}),
  ...(disposition === 'accepted_risk' ? { authority_ref: 'approval-1' } : {}),
});
const evaluate = (rounds: DocumentReviewRound[], resolutions: DocumentReviewResolution[] = []) =>
  evaluateDocumentReviewRounds({ requested_reviewers: ['comprehension'], rounds, resolutions });

const evaluateVerifiedFix = (rounds: DocumentReviewRound[]) => {
  const fixed = resolution('fixed');
  return evaluateDocumentReviewRounds(
    { requested_reviewers: ['comprehension'], rounds, resolutions: [fixed] },
    () => ({
      finding_id: id,
      artifact_sha256: NEXT_HASH,
      semantic_scope: issue.semantic_scope,
      evidence_refs: fixed.evidence_refs,
    })
  );
};

describe('document review round evaluation', () => {
  it('requires two complete clean rounds of the same artifact', () => {
    expect(evaluate([round(1)]).status).toBe('continue');
    expect(evaluate([round(1), round(2)]).status).toBe('converged');
    expect(evaluate([round(1), round(2, [], NEXT_HASH)]).consecutive_clean_rounds).toBe(1);
  });
  it('does not count a missing or not_run reviewer as zero findings', () => {
    const missing = { ...round(2), reviewers: [] };
    const notRun = round(2);
    notRun.reviewers[0]!.status = 'not_run';
    expect(evaluate([round(1), missing]).clean).toBe(false);
    expect(evaluate([round(1), notRun]).consecutive_clean_rounds).toBe(0);
  });
  it('does not let a later reviewer silently forget an unresolved blocker', () => {
    expect(evaluate([round(1, [issue]), round(2), round(3)]).status).toBe('continue');
    expect(evaluate([round(1, [issue]), round(2)]).open_findings).toHaveLength(1);
  });
  it('only counts rounds after a fix and requires fresh confirmation twice', () => {
    const fixed = resolution('fixed');
    expect(evaluate([round(1, [issue])], [fixed]).clean).toBe(false);
    expect(evaluateVerifiedFix([round(1, [issue]), round(2, [], NEXT_HASH)]).status).toBe(
      'continue'
    );
    expect(
      evaluateVerifiedFix([round(1, [issue]), round(2, [], NEXT_HASH), round(3, [], NEXT_HASH)])
        .status
    ).toBe('converged');
  });
  it('reopens recurring fixes even when lines move or severity is downgraded', () => {
    const recurring = { ...issue, location: 'line 99', severity: 'suggestion' as const };
    const result = evaluateVerifiedFix([round(1, [issue]), round(2, [recurring], NEXT_HASH)]);
    expect(result.reopened_finding_ids).toEqual([id]);
    expect(result.open_findings[0]!.severity).toBe('blocking');
    expect(result.clean).toBe(false);
    expect(documentReviewFindingId(identity)).toBe(id);
  });
  it.each(['contested', 'accepted_risk'] as const)(
    'requires independently verified evidence for %s',
    (disposition) => {
      const record = resolution(disposition);
      expect(evaluate([round(1, [issue]), round(2)], [record]).clean).toBe(false);
      const result = evaluateDocumentReviewRounds(
        {
          requested_reviewers: ['comprehension'],
          rounds: [round(1, [issue]), round(2), round(3)],
          resolutions: [record],
        },
        () => ({
          finding_id: id,
          artifact_sha256: HASH,
          semantic_scope: issue.semantic_scope,
          evidence_refs: record.evidence_refs,
          authority_ref: record.authority_ref,
        })
      );
      expect(result.status).toBe('converged');
    }
  );
  it('reopens a settled suggestion when a later report identifies a blocker', () => {
    const record = resolution('accepted_risk');
    const result = evaluateDocumentReviewRounds(
      {
        requested_reviewers: ['comprehension'],
        rounds: [round(1, [{ ...issue, severity: 'suggestion' }]), round(2, [issue])],
        resolutions: [record],
      },
      () => ({
        finding_id: id,
        artifact_sha256: HASH,
        semantic_scope: issue.semantic_scope,
        evidence_refs: record.evidence_refs,
        authority_ref: record.authority_ref,
      })
    );
    expect(result.clean).toBe(false);
    expect(result.open_findings[0]?.severity).toBe('blocking');
  });
  it('rejects accepted risk without approval and mismatched verification bindings', () => {
    const record = resolution('accepted_risk');
    const input = {
      requested_reviewers: ['comprehension'],
      rounds: [round(1, [issue]), round(2)],
      resolutions: [record],
    };
    const base = {
      finding_id: id,
      artifact_sha256: HASH,
      semantic_scope: issue.semantic_scope,
      evidence_refs: record.evidence_refs,
    };
    expect(evaluateDocumentReviewRounds(input, () => base).clean).toBe(false);
    expect(
      evaluateDocumentReviewRounds(input, () => ({ ...base, authority_ref: 'approval-other' }))
        .clean
    ).toBe(false);
    expect(
      evaluateDocumentReviewRounds(input, () => ({
        ...base,
        authority_ref: 'approval-1',
        artifact_sha256: NEXT_HASH,
      })).clean
    ).toBe(false);
    expect(
      evaluateDocumentReviewRounds(input, () => ({
        ...base,
        authority_ref: 'approval-1',
        evidence_refs: [],
      })).clean
    ).toBe(false);
  });
  it('invalidates settlements when the reviewed artifact changes', () => {
    const record = resolution('contested');
    const result = evaluateDocumentReviewRounds(
      {
        requested_reviewers: ['comprehension'],
        rounds: [round(1, [issue]), round(2), round(3, [], NEXT_HASH)],
        resolutions: [record],
      },
      () => ({
        finding_id: id,
        artifact_sha256: HASH,
        semantic_scope: issue.semantic_scope,
        evidence_refs: record.evidence_refs,
      })
    );
    expect(result.clean).toBe(false);
    expect(result.open_findings).toHaveLength(1);
  });
  it('suggestions and declined suggestions do not block, but declined blockers do', () => {
    expect(
      evaluate(
        [round(1, [{ ...issue, severity: 'suggestion' }]), round(2)],
        [resolution('declined')]
      ).status
    ).toBe('converged');
    expect(evaluate([round(1, [issue]), round(2)], [resolution('declined')]).clean).toBe(false);
  });
  it('stops at five rounds without silently accepting residual findings', () => {
    const result = evaluate(Array.from({ length: 5 }, (_, i) => round(i + 1, [issue])));
    expect(result.status).toBe('needs_decision');
    expect(result.open_findings).toHaveLength(1);
    expect(() => evaluate(Array.from({ length: 6 }, (_, i) => round(i + 1)))).toThrow();
  });
  it('detects explicitly linked fix/reversion churn only for verified changed-artifact fixes', () => {
    const churn = { ...issue, issue_key: 'new-issue', reverting_fix_id: 'fix-1' };
    expect(evaluateVerifiedFix([round(1, [issue]), round(2, [churn], NEXT_HASH)]).status).toBe(
      'needs_decision'
    );
    expect(
      evaluateVerifiedFix([
        round(1, [issue]),
        round(2, [{ ...churn, semantic_scope: 'other' }], NEXT_HASH),
      ]).status
    ).toBe('continue');
    expect(
      evaluate([round(1, [issue]), round(2, [churn], NEXT_HASH)], [resolution('fixed')]).status
    ).toBe('continue');
  });
  it('cannot converge from an unverified fix or a verified claim about unchanged content', () => {
    const unchanged = [round(1, [issue]), round(2), round(3)];
    const fixed = resolution('fixed');
    expect(evaluate(unchanged, [fixed]).status).toBe('continue');
    const input = {
      requested_reviewers: ['comprehension'],
      rounds: unchanged,
      resolutions: [fixed],
    };
    const sameArtifact = evaluateDocumentReviewRounds(input, () => ({
      finding_id: id,
      artifact_sha256: HASH,
      semantic_scope: issue.semantic_scope,
      evidence_refs: fixed.evidence_refs,
    }));
    expect(sameArtifact.status).toBe('continue');
    expect(sameArtifact.reasons).toContain(
      'A fixed finding requires a verified changed artifact revision'
    );
    const corrected = [round(1, [issue]), round(2, [], NEXT_HASH), round(3, [], NEXT_HASH)];
    expect(evaluate(corrected, [fixed]).status).toBe('continue');
    for (const wrong of [
      { finding_id: 'c'.repeat(64) },
      { artifact_sha256: HASH },
      { semantic_scope: 'other' },
      { evidence_refs: ['unrelated'] },
    ]) {
      expect(
        evaluateDocumentReviewRounds({ ...input, rounds: corrected }, () => ({
          finding_id: id,
          artifact_sha256: NEXT_HASH,
          semantic_scope: issue.semantic_scope,
          evidence_refs: fixed.evidence_refs,
          ...wrong,
        })).status
      ).toBe('continue');
    }
  });
  it('invalidates verified fixes when a subsequent artifact version changes again', () => {
    const result = evaluateVerifiedFix([
      round(1, [issue]),
      round(2, [], NEXT_HASH),
      round(3, [], 'c'.repeat(64)),
    ]);
    expect(result.clean).toBe(false);
    expect(result.reopened_finding_ids).toEqual([id]);
  });
  it('fails closed on malformed, duplicate or mismatched reports and resolutions', () => {
    expect(() =>
      evaluateDocumentReviewRounds({
        requested_reviewers: ['comprehension', 'comprehension'],
        rounds: [round(1)],
      })
    ).toThrow(/Duplicate requested/);
    const duplicate = round(1);
    duplicate.reviewers.push(duplicate.reviewers[0]!);
    expect(() => evaluate([duplicate])).toThrow(/duplicate reviewer/);
    const wrongHash = round(1);
    wrongHash.reviewers[0]!.artifact_sha256 = NEXT_HASH;
    expect(() => evaluate([wrongHash])).toThrow(/hash mismatch/);
    expect(() => evaluate([round(2)])).toThrow(/contiguous/);
    expect(() => evaluate([round(1, [issue, issue])])).toThrow(/Duplicate reviewer finding/);
    expect(() =>
      evaluate([round(1, [issue])], [{ ...resolution('fixed'), artifact_sha256: NEXT_HASH }])
    ).toThrow(/artifact/);
    expect(() =>
      evaluate([round(1, [issue])], [{ ...resolution('fixed'), finding_id: 'c'.repeat(64) }])
    ).toThrow(/unknown/);
    expect(() => evaluate([round(1, [issue])], [resolution('fixed'), resolution('fixed')])).toThrow(
      /Duplicate finding resolution/
    );
    expect(() =>
      evaluate([round(1, [issue])], [{ ...resolution('fixed'), fix_id: undefined }])
    ).toThrow(/fix_id/);
  });
});
