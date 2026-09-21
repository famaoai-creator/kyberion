import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  type JudgmentBackend,
  type JudgmentQuestion,
} from './judgment-backend.js';
import { registerOrganizationWorkJudgment } from './organization-operating-model-persistence.js';
import { assistWithJudgment, choiceAnswer } from './judgment-assist.js';

const QUESTION: JudgmentQuestion = {
  kind: 'choice',
  id: 'error.category',
  options: ['network', 'auth'],
  optionDescriptions: { network: 'a network failure', auth: 'a credential failure' },
  instructions: 'What kind of failure is this?',
};

function provider(overrides: Partial<JudgmentBackend> = {}): JudgmentBackend {
  return {
    judgment_id: 'stub-local',
    egress: 'local-only',
    supports: () => true,
    async judge(request) {
      return request.questions.map((question) => ({
        id: question.id,
        value: 'network',
        confidence: 0.95,
        calibrated: false,
      }));
    },
    ...overrides,
  };
}

const base = {
  baseline: 'unknown',
  state: 'ECONNREFUSED 127.0.0.1:443',
  questions: [QUESTION],
  tier: 'public' as const,
  accept: (answers: any) => (choiceAnswer(answers, QUESTION.id)?.value as string) ?? undefined,
};

afterEach(() => {
  resetJudgmentBackends();
  vi.restoreAllMocks();
});

describe('assistWithJudgment fallback contract', () => {
  it('refines the baseline when a provider answers confidently', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider());
    const result = await assistWithJudgment(base);
    expect(result.source).toBe('judgment');
    expect(result.value).toBe('network');
    expect(result.provider_id).toBe('stub-local');
  });

  it('keeps the baseline when no provider is registered at all', async () => {
    const result = await assistWithJudgment(base);
    expect(result.source).toBe('baseline');
    expect(result.value).toBe('unknown');
    expect(result.reason).toMatch(/unavailable/);
  });

  it('keeps the baseline when the provider throws', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(
      provider({
        async judge() {
          throw new Error('worker exploded');
        },
      })
    );
    // The seam degrades to the rules, which cannot answer this question, so
    // the assist must still land on the baseline rather than a rule answer
    // for a different question.
    const result = await assistWithJudgment(base);
    expect(result.value).toBe('unknown');
  });

  it('uses the same declined wording for malformed answer counts', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(
      provider({
        async judge() {
          return [];
        },
      })
    );
    const result = await assistWithJudgment(base);
    expect(result.source).toBe('baseline');
    expect(result.reason).toMatch(/declined malformed provider answer/);
  });

  it('keeps the baseline when the provider hangs, and does not hang with it', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(
      provider({
        judge: () => new Promise(() => undefined),
      })
    );
    const started = Date.now();
    const result = await assistWithJudgment({ ...base, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.source).toBe('baseline');
    expect(result.reason).toMatch(/timed out/);
  });

  it('keeps the baseline below the confidence floor', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(
      provider({
        async judge(request) {
          return request.questions.map((question) => ({
            id: question.id,
            value: 'network',
            confidence: 0.4,
            calibrated: false,
          }));
        },
      })
    );
    const result = await assistWithJudgment(base);
    expect(result.source).toBe('baseline');
    expect(result.reason).toMatch(/confidence below/);
    // The answer is still reported, so a caller can log what was declined.
    expect(result.answers?.[0].value).toBe('network');
  });

  it('declines every answer while requireCalibrated is set, since nothing is calibrated', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider());
    const result = await assistWithJudgment({ ...base, requireCalibrated: true });
    expect(result.source).toBe('baseline');
    expect(result.reason).toMatch(/not calibrated/);
  });

  it('keeps the baseline when the caller declines the answer', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider());
    const result = await assistWithJudgment({
      ...base,
      // A monotonicity rule: this site only accepts 'auth', never 'network'.
      accept: (answers) => {
        const answer = choiceAnswer(answers, QUESTION.id);
        return answer?.value === 'auth' ? 'auth' : undefined;
      },
    });
    expect(result.source).toBe('baseline');
    expect(result.reason).toMatch(/declined/);
  });

  it('keeps the baseline when the caller mapping throws', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider());
    const result = await assistWithJudgment({
      ...base,
      accept: () => {
        throw new Error('bad mapping');
      },
    });
    expect(result.source).toBe('baseline');
    expect(result.reason).toMatch(/accept\(\) threw/);
  });

  it('never lets personal-tier state reach an external provider', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider({ judgment_id: 'stub-external', egress: 'external-api' }));
    const result = await assistWithJudgment({ ...base, tier: 'personal' });
    // Egress refuses it and no other provider can answer, so the baseline
    // stands rather than a wrong answer from the rules.
    expect(result.value).toBe('unknown');
    expect(result.provider_id).not.toBe('stub-external');
  });

  it('does let personal-tier state reach a declared local-only provider', async () => {
    registerOrganizationWorkJudgment();
    // 'laya-mlx' is declared local-only with training_use 'none' in the
    // provider egress policy, which is what makes personal tier reachable.
    registerJudgmentBackend(provider({ judgment_id: 'laya-mlx', egress: 'local-only' }));
    const result = await assistWithJudgment({ ...base, tier: 'personal' });
    expect(result.source).toBe('judgment');
    expect(result.provider_id).toBe('laya-mlx');
  });

  it('keeps the baseline rather than answering a question nobody supports', async () => {
    // Only the rules are registered, and they answer organization work
    // shapes — not error categories. The floor must produce no answer.
    registerOrganizationWorkJudgment();
    const result = await assistWithJudgment(base);
    expect(result.source).toBe('baseline');
    expect(result.value).toBe('unknown');
    expect(result.reason).toMatch(/no provider can answer/);
  });

  it('keeps the baseline for empty state or no questions', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider());
    expect((await assistWithJudgment({ ...base, state: '   ' })).source).toBe('baseline');
    expect((await assistWithJudgment({ ...base, questions: [] })).source).toBe('baseline');
  });
});
