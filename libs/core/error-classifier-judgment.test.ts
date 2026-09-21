import { afterEach, describe, expect, it } from 'vitest';
import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  type JudgmentBackend,
} from './judgment-backend.js';
import { registerOrganizationWorkJudgment } from './organization-operating-model-persistence.js';
import { classifyError } from './error-classifier.js';
import {
  classifyErrorAssisted,
  ERROR_CATEGORY_DESCRIPTIONS,
  ERROR_CATEGORY_QUESTION,
  errorCategoryQuestion,
} from './error-classifier-judgment.js';

/** A local-only provider the egress policy declares, so personal tier works. */
function provider(value: string, confidence = 0.95): JudgmentBackend {
  return {
    judgment_id: 'laya-mlx',
    egress: 'local-only',
    supports: (question) => question.id === ERROR_CATEGORY_QUESTION,
    async judge(request) {
      return request.questions.map((question) => ({
        id: question.id,
        value,
        confidence,
        calibrated: false,
      }));
    },
  };
}

/** Matches a rule: [PROVIDER_EGRESS_DENIED]-style governance text is classified. */
const MATCHED = 'ECONNREFUSED 127.0.0.1:443 connect failed';
/** Matches nothing, so the rules return 'unknown'. */
const UNMATCHED = '[OP_KIND_MISMATCH] knowledge_search is registered as capture';

afterEach(() => {
  resetJudgmentBackends();
});

describe('classifyErrorAssisted', () => {
  it('never second-guesses a category a rule already decided', async () => {
    const baseline = classifyError(MATCHED);
    expect(baseline.category).not.toBe('unknown');

    registerOrganizationWorkJudgment();
    // A provider that would answer differently must not get the chance.
    registerJudgmentBackend(provider('tier_violation'));

    const result = await classifyErrorAssisted(MATCHED);
    expect(result.category).toBe(baseline.category);
    expect(result.source).toBe('rules');
    expect(result.ruleId).toBe(baseline.ruleId);
  });

  it('refines only what the rules left unknown', async () => {
    expect(classifyError(UNMATCHED).category).toBe('unknown');

    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('invalid_input'));

    const result = await classifyErrorAssisted(UNMATCHED);
    expect(result.category).toBe('invalid_input');
    expect(result.source).toBe('judgment');
    expect(result.ruleId).toBe('judgment');
    expect(result.remediation).toBe(ERROR_CATEGORY_DESCRIPTIONS.invalid_input);
  });

  it('is byte-identical to classifyError when no provider exists', async () => {
    const baseline = classifyError(UNMATCHED);
    const result = await classifyErrorAssisted(UNMATCHED);
    expect(result.category).toBe(baseline.category);
    expect(result.ruleId).toBe(baseline.ruleId);
    expect(result.label).toBe(baseline.label);
    expect(result.source).toBe('rules');
  });

  it('keeps unknown when the provider is unsure', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('network', 0.3));
    const result = await classifyErrorAssisted(UNMATCHED);
    expect(result.category).toBe('unknown');
    expect(result.judgment_reason).toMatch(/confidence below/);
  });

  it('keeps unknown when the provider answers outside the enum', async () => {
    registerOrganizationWorkJudgment();
    // 'unknown' is a real ErrorCategory but not a classification; an answer
    // outside the offered options is a provider bug, not a category.
    registerJudgmentBackend(provider('unknown'));
    const result = await classifyErrorAssisted(UNMATCHED);
    expect(result.category).toBe('unknown');
    expect(result.judgment_reason).toMatch(/declined/);
  });

  it('keeps unknown when the provider throws', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider('network'),
      async judge() {
        throw new Error('worker exploded');
      },
    });
    const result = await classifyErrorAssisted(UNMATCHED);
    expect(result.category).toBe('unknown');
  });

  it('keeps unknown while requireCalibrated is set', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('network'));
    const result = await classifyErrorAssisted(UNMATCHED, { requireCalibrated: true });
    expect(result.category).toBe('unknown');
    expect(result.judgment_reason).toMatch(/not calibrated/);
  });

  it('defaults to personal tier, so an external provider never sees the error text', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider('network'),
      judgment_id: 'typesafe-jev',
      egress: 'external-api',
    });
    const result = await classifyErrorAssisted(UNMATCHED);
    // Error text quotes paths and payloads; it must not leave the machine.
    expect(result.category).toBe('unknown');
  });

  it('offers every rule category with a description', () => {
    const question = errorCategoryQuestion();
    expect(question.kind).toBe('choice');
    if (question.kind !== 'choice') return;
    expect(question.options).toContain('tier_violation');
    expect(question.options).not.toContain('unknown');
    for (const option of question.options) {
      expect(question.optionDescriptions?.[option], `missing description for ${option}`).toBeTruthy();
    }
  });
});
