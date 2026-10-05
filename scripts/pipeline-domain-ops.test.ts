import { describe, expect, it } from 'vitest';
import { buildProductivityTaskPlan } from '@agent/core/productivity-task-plan';
import {
  parseInlineOnboardingInput,
  runInlineApprovalStoreHygiene,
  runInlineDecisionDigest,
  runInlineProductivityDryRunValidation,
  runInlineProposalBriefParse,
} from './pipeline-domain-ops.js';

describe('pipeline domain JSON input boundaries', () => {
  it('accepts object onboarding input from JSON text and values', () => {
    expect(parseInlineOnboardingInput('{"identity":{"name":"Operator"}}')).toEqual({
      identity: { name: 'Operator' },
    });
    expect(parseInlineOnboardingInput({ identity: { name: 'Operator' } })).toEqual({
      identity: { name: 'Operator' },
    });
  });

  it.each(['[]', 'null', '"text"'])('rejects non-object onboarding input %s', (raw) => {
    expect(() => parseInlineOnboardingInput(raw)).toThrow('onboarding input must be a JSON object');
  });

  it('rejects dangerous keys before onboarding effects', () => {
    expect(() =>
      parseInlineOnboardingInput('{"identity":{"__proto__":{"polluted":true}}}')
    ).toThrow('onboarding input contains a dangerous JSON key');
  });

  it('rejects dangerous external proposal JSON before pipeline effects', () => {
    expect(() =>
      runInlineProposalBriefParse(
        { produces: 'proposal' } as never,
        { input: '{"nested":{"prototype":{"polluted":true}}}' },
        { tenant_slug: 'demo' }
      )
    ).toThrow('deck_brief_raw contains a dangerous JSON key');
  });

  it('validates the full productivity task plan contract before projection', () => {
    const plan = buildProductivityTaskPlan('会議の日程を変更して参加者にメールを送って');
    const result = runInlineProductivityDryRunValidation(
      { produces: 'review_package' } as never,
      { input: JSON.stringify(plan) },
      { mission_id: 'MSN-PRODUCTIVITY-TEST' }
    );

    expect(result.review_package).toMatchObject({
      kind: 'productivity-review-package',
      status: 'approval_required',
      external_effects_executed: false,
    });
  });

  it('rejects malformed productivity task plan fields before projection', () => {
    const plan = buildProductivityTaskPlan('予定を確認する');
    expect(() =>
      runInlineProductivityDryRunValidation(
        { produces: 'review_package' } as never,
        {
          input: JSON.stringify({
            ...plan,
            approval: { ...plan.approval, required: 'yes' },
          }),
        },
        { mission_id: 'MSN-PRODUCTIVITY-TEST' }
      )
    ).toThrow('invalid productivity task plan shape');
  });
});

describe('decision loop pipeline ops', () => {
  it('rejects an unsupported digest locale before reading the store', () => {
    expect(() =>
      runInlineDecisionDigest({ id: 'digest' } as never, { locale: 'xx-zz' }, {})
    ).toThrow('core:decision_digest: unsupported locale xx-zz');
  });

  it('builds the digest without sending unless send is true', () => {
    const result = runInlineDecisionDigest({ id: 'digest' } as never, { locale: 'en' }, {});
    const value = result.last_transform as Record<string, unknown>;
    expect(value).toMatchObject({ sent: false });
    expect(typeof value.text).toBe('string');
  });

  it('reports the hygiene sweep as a dry run unless apply is true and skips fixtures', () => {
    const result = runInlineApprovalStoreHygiene({ id: 'hygiene' } as never, {}, {});
    expect(result.last_transform).toMatchObject({ dry_run: true, fixtures_trashed: 0 });
  });
});
