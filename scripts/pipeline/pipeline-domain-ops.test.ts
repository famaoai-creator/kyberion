import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProductivityTaskPlan } from '@agent/core/productivity-task-plan';
import {
  parseInlineOnboardingInput,
  runInlineApprovalStoreHygiene,
  runInlineCustomerDecisionLearning,
  runInlineCustomerDecisionReminders,
  runInlineDecisionDigest,
  runInlineMissionCreate,
  runInlineMissionStartFromIssues,
  runInlineProductivityDryRunValidation,
  runInlineProposalBriefParse,
} from './pipeline-domain-ops.js';
import { main as missionController } from '../mission_controller.js';

vi.mock('../mission_controller.js', () => ({ main: vi.fn(async () => undefined) }));

describe('mission pipeline ingress', () => {
  beforeEach(() => vi.mocked(missionController).mockClear());

  it('requires a mission ID and keeps optional named fields in their own positions', async () => {
    const step = { id: 'create' } as never;
    await expect(runInlineMissionCreate(step, { tier: 'public' }, {})).rejects.toThrow(
      'requires mission_id'
    );
    expect(missionController).not.toHaveBeenCalled();
    await runInlineMissionCreate(
      step,
      { mission_id: 'msn-public-test', tier: 'public', tenant_id: 'default', persona: 'worker' },
      {}
    );
    expect(missionController).toHaveBeenCalledWith([
      'create',
      'MSN-PUBLIC-TEST',
      '--tier',
      'public',
      '--org-role',
      'worker',
    ]);
  });

  it('uses the repository and issue number when a GitHub issue title changes', async () => {
    const step = { id: 'ingest' } as never;
    const issue = { number: 42, title: '--force', url: 'https://github.com/owner/repo/issues/42' };
    await runInlineMissionStartFromIssues(
      step,
      {},
      { raw_issues: { stdout: JSON.stringify([issue]) } }
    );
    await runInlineMissionStartFromIssues(step, { issues: [{ ...issue, title: 'Edited' }] }, {});
    const first = vi.mocked(missionController).mock.calls[0]?.[0];
    const second = vi.mocked(missionController).mock.calls[1]?.[0];
    expect(first?.[1]).toMatch(/^MSN-GH-[A-F0-9]{16}-42$/);
    expect(second?.[1]).toBe(first?.[1]);
    expect(first?.slice(2)).toEqual(['--tier', 'personal', '--goal', 'GitHub issue #42: --force']);
  });
});

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
    expect(result.last_transform).toMatchObject({
      dry_run: true,
      fixtures_trashed: 0,
      tenant_records_in_system_tree: expect.any(Number),
    });
  });
});

describe('core:customer_decision_reminders (CD-11)', () => {
  it('refuses to run outside a tenant-bound run, before reading any store', async () => {
    const saved = process.env.KYBERION_TENANT;
    delete process.env.KYBERION_TENANT;
    try {
      await expect(
        runInlineCustomerDecisionReminders({ id: 'remind' } as never, {}, {})
      ).rejects.toThrow('CUSTOMER_DECISION_REMINDERS_TENANT_REQUIRED');
    } finally {
      if (saved !== undefined) process.env.KYBERION_TENANT = saved;
    }
  });
});

describe('core:customer_decision_learning (CD-12)', () => {
  it('refuses to run outside a tenant-bound run, before reading any store', async () => {
    const saved = process.env.KYBERION_TENANT;
    delete process.env.KYBERION_TENANT;
    try {
      await expect(
        runInlineCustomerDecisionLearning({ id: 'learn' } as never, {}, {})
      ).rejects.toThrow('CUSTOMER_DECISION_LEARNING_TENANT_REQUIRED');
    } finally {
      if (saved !== undefined) process.env.KYBERION_TENANT = saved;
    }
  });
});
