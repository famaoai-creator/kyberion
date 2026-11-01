import { describe, expect, it } from 'vitest';
import {
  continuousDevelopmentConsentSummary,
  continuousDevelopmentDecisionPresentation,
  continuousDevelopmentAlignmentScope,
  assertContinuousDevelopmentApprovalPresentation,
} from './continuous-development-consent.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotActionRecord } from '../dot/dot-action-ledger.js';
import { DOT_ACTION_LEDGER_PATH } from '../dot/dot-action-ledger.js';
const development = {
  cwd: '.',
  repository_url: 'https://github.com/owner/repository',
  source_edit_paths: ['libs/core/example.ts'],
  implementation_task_id: 'execution-implement',
  review_task_id: 'self_review-code-review',
  title: 'fix: improve',
  body_file: 'evidence/pr-body.md',
};
const charter = { title: 'Owner', scope: { tier: 'public', organization_id: 'ops' } } as DotCharter;
const record = {
  action_ref: 'dact-example',
  title: 'Improve',
  objective: 'Long optional context '.repeat(100),
  continuous_work: {
    kind: 'mission',
    missions: [
      {
        key: 'improve',
        title: 'Improve',
        goal: 'Improve',
        success_condition: 'Verified merge',
        development,
      },
    ],
  },
  admission: { semantic_hash: 'a'.repeat(64) },
} as DotActionRecord;
describe('visible continuous development consent', () => {
  it('keeps security facts complete before trimming optional context and uses the existing public ledger', () => {
    const presentation = continuousDevelopmentDecisionPresentation(charter, record)!;
    expect(
      presentation.question.startsWith(
        continuousDevelopmentConsentSummary(development, charter.scope)
      )
    ).toBe(true);
    expect(presentation.question.length).toBeLessThanOrEqual(1000);
    expect(presentation.question).toContain('agent/kyberion-development → main');
    expect(presentation.question).toContain('maximum code repairs: 2');
    expect(presentation.evidence[0]?.ref).toBe(DOT_ACTION_LEDGER_PATH);
    expect(presentation.evidence[0]?.label).toContain(record.admission!.semantic_hash);
  });
  it('rejects an oversized security prefix instead of silently clipping the reviewed repository', () => {
    expect(() =>
      continuousDevelopmentConsentSummary(
        { ...development, repository_url: `https://${'a'.repeat(1000)}.example/owner/repository` },
        charter.scope
      )
    ).toThrow('security summary exceeds');
  });
  it('keeps personal review content explicitly personal and owner-bound without inventing a tenant', () => {
    const personal = {
      ...charter,
      scope: { tier: 'personal' as const, organization_id: 'ops', owner_nhi: 'consent-owner' },
    };
    const presentation = continuousDevelopmentDecisionPresentation(personal, record)!;
    expect(presentation.scope).toEqual({ tier: 'personal', nhi_id: 'consent-owner' });
    expect(presentation.evidence[0]?.ref).toContain('/personal/shared/owners/');
    expect(presentation.evidence[0]?.ref).not.toBe(DOT_ACTION_LEDGER_PATH);
  });
  it('keeps all64 exact paths and the owner-bound descriptor reference in alignment evidence', () => {
    const files = Array.from({ length: 64 }, (_, index) => `libs/core/reviewed-${index}.ts`);
    const scope = continuousDevelopmentAlignmentScope(
      { ...development, source_edit_paths: files },
      { tier: 'public', organization_id: 'ops' }
    );
    expect(scope).toContain(
      'Full owner-bound reviewed descriptor: evidence/continuous-owner.json (development_hash).'
    );
    expect(scope.filter((line) => line.startsWith('Exact approved source file: '))).toEqual(
      files.map((file) => `Exact approved source file: ${file}`)
    );
    expect(scope[0]).toContain('Exact source files: 64');
  });
  it('refuses an old hash-bound approval whose visible scope or full-plan evidence is missing', () => {
    const visible = continuousDevelopmentDecisionPresentation(charter, record)!;
    const approval = {
      decisionCard: { question: visible.question, evidence: visible.evidence },
      scope: visible.scope,
    } as unknown as Pick<
      import('../governance/approval-store.js').ApprovalRequestRecord,
      'decisionCard' | 'scope'
    >;
    expect(() =>
      assertContinuousDevelopmentApprovalPresentation(charter, record, approval)
    ).not.toThrow();
    expect(() =>
      assertContinuousDevelopmentApprovalPresentation(charter, record, {
        ...approval,
        decisionCard: { ...approval.decisionCard!, evidence: [] },
      })
    ).toThrow('presentation changed');
    expect(() =>
      assertContinuousDevelopmentApprovalPresentation(charter, record, {
        ...approval,
        scope: { tier: 'personal', scope_kind: 'system' },
      })
    ).toThrow('presentation changed');
  });
});
