import { afterEach, describe, expect, it } from 'vitest';
import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  type JudgmentBackend,
  type JudgmentQuestion,
} from './judgment-backend.js';
import { registerOrganizationWorkJudgment } from './organization-operating-model-persistence.js';
import {
  evaluateCallSite,
  recommendRequireCalibrated,
  type CallSiteCase,
  type CallSiteEvaluation,
} from './judgment-callsite-eval.js';

const QUESTION_ID = 'test.category';
const question = (): JudgmentQuestion => ({
  kind: 'choice',
  id: QUESTION_ID,
  options: ['a', 'b'],
  optionDescriptions: { a: 'the first kind', b: 'the second kind' },
  instructions: 'Which kind is this?',
});

const CASES: CallSiteCase[] = Array.from({ length: 12 }, (_, index) => ({
  id: `case-${index}`,
  state: `state ${index}`,
  expected: index % 2 === 0 ? 'a' : 'b',
}));

/** Answers `answerFor(state)` at `confidence`; optionally varies per run. */
function provider(
  answerFor: (state: string) => string,
  confidence: number,
  unstableFor: (state: string) => boolean = () => false
): JudgmentBackend {
  const counters = new Map<string, number>();
  return {
    judgment_id: 'laya-mlx',
    egress: 'local-only',
    supports: () => true,
    async judge(request) {
      const seen = (counters.get(request.state) ?? 0) + 1;
      counters.set(request.state, seen);
      const drift = unstableFor(request.state) && seen > 1;
      return request.questions.map((q) => ({
        id: q.id,
        value: drift ? 'b' : answerFor(request.state),
        confidence,
        calibrated: false,
      }));
    },
  };
}

const evaluate = () =>
  evaluateCallSite({ questionId: QUESTION_ID, question, cases: CASES, tier: 'personal', repeats: 2 });

afterEach(() => {
  resetJudgmentBackends();
});

describe('evaluateCallSite', () => {
  it('measures accuracy and the confidently-wrong rate separately', async () => {
    registerOrganizationWorkJudgment();
    // Always answers 'a': right on the six even cases, wrong on six odd ones,
    // and confident throughout.
    registerJudgmentBackend(provider(() => 'a', 0.9));
    const evaluation = await evaluate();
    expect(evaluation.answered).toBe(12);
    expect(evaluation.accuracy).toBeCloseTo(0.5, 5);
    expect(evaluation.aboveFloor).toBe(12);
    expect(evaluation.confidentlyWrong).toBe(6);
    expect(evaluation.confidentlyWrongRate).toBeCloseTo(0.5, 5);
  });

  it('counts nothing as confidently wrong when the provider stays below the floor', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(() => 'a', 0.3));
    const evaluation = await evaluate();
    // Half its answers are wrong, but it never claims them.
    expect(evaluation.accuracy).toBeCloseTo(0.5, 5);
    expect(evaluation.aboveFloor).toBe(0);
    expect(evaluation.confidentlyWrongRate).toBe(0);
  });

  it('detects a provider that disagrees with itself', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(() => 'a', 0.9, (state) => state.endsWith('3')));
    const evaluation = await evaluate();
    expect(evaluation.unstable).toBe(1);
  });

  it('records a case that produced no answer instead of scoring it', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider(() => 'a', 0.9),
      async judge() {
        throw new Error('worker exploded');
      },
    });
    const evaluation = await evaluate();
    // The seam degrades to the rules, which cannot answer this question.
    expect(evaluation.answered).toBe(0);
    expect(evaluation.results.every((result) => result.error)).toBe(true);
  });
});

describe('recommendRequireCalibrated', () => {
  const evaluation = (over: Partial<CallSiteEvaluation>): CallSiteEvaluation => ({
    questionId: QUESTION_ID,
    results: Array.from({ length: 12 }, (_, index) => ({
      id: `c${index}`,
      expected: 'a',
      actual: 'a',
      confidence: 0.9,
      correct: true,
      stable: true,
    })),
    answered: 12,
    accuracy: 1,
    aboveFloor: 12,
    confidentlyWrong: 0,
    confidentlyWrongRate: 0,
    unstable: 0,
    reliability: { samples: 12, accuracy: 1, ece: 0.1, overconfidence: 0.1, bins: [] },
    ...over,
  });

  it('clears a stable provider that is rarely confidently wrong', () => {
    const recommendation = recommendRequireCalibrated(evaluation({}));
    expect(recommendation.requireCalibrated).toBe(false);
  });

  it('requires a fit when confident answers are often wrong', () => {
    const recommendation = recommendRequireCalibrated(
      evaluation({ confidentlyWrong: 6, confidentlyWrongRate: 0.5, accuracy: 0.5 })
    );
    expect(recommendation.requireCalibrated).toBe(true);
    expect(recommendation.reason).toMatch(/confident answers were wrong/);
  });

  it('requires a fit when runs disagree, however accurate', () => {
    const recommendation = recommendRequireCalibrated(evaluation({ unstable: 1 }));
    expect(recommendation.requireCalibrated).toBe(true);
    expect(recommendation.reason).toMatch(/disagreed/);
  });

  it('treats thin evidence exactly like bad evidence', () => {
    const recommendation = recommendRequireCalibrated(evaluation({ aboveFloor: 4 }));
    expect(recommendation.requireCalibrated).toBe(true);
    expect(recommendation.reason).toMatch(/only 4 answers cleared/);
  });

  it('requires a fit when any case failed to answer', () => {
    const thrown = evaluation({});
    thrown.results[0] = { ...thrown.results[0], error: 'worker exploded' };
    const recommendation = recommendRequireCalibrated(thrown);
    expect(recommendation.requireCalibrated).toBe(true);
    expect(recommendation.reason).toMatch(/did not produce an answer/);
  });
});
