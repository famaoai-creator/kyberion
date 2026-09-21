/**
 * Measuring whether a provider is competent at one call site.
 *
 * Competence does not transfer. The same Laya checkpoint classifies Japanese
 * work requests 6 of 6 and this repository's error taxonomy 1 of 5, and it
 * is equally deterministic in both — a fixed-weight encoder always agrees
 * with itself, including when it is wrong. So "is this provider good enough
 * here" is a question per question id, not per provider, and it has to be
 * answered by measurement rather than by whoever is wiring the call site.
 *
 * ## The number that decides
 *
 * `assistWithJudgment` already refuses an answer that is absent, weak, slow
 * or malformed. What it cannot refuse is one that is **confidently wrong**:
 * a provider called `[RESOURCE_PATH_SCOPE] resource path is outside the
 * repository root` a `resource_unavailable` at 0.998, and a confidence floor
 * of 0.7 lets that straight through.
 *
 * So the metric that decides whether a call site may act on an unfitted
 * number is `confidentlyWrongRate`: of the answers that clear the floor, how
 * many are wrong. Accuracy is the wrong summary here — a provider that
 * abstains on everything it does not know is useful at 40% accuracy, and one
 * that is assertive about its mistakes is dangerous at 80%.
 */

import { computeReliability, type ReliabilityReport } from './judgment-calibration-fit.js';
import { judge, type JudgmentAnswer, type JudgmentQuestion } from './judgment-backend.js';
import type { TierLevel } from './types.js';

export interface CallSiteCase {
  id: string;
  /** The material to judge. */
  state: string;
  /** The answer a correct system would give. */
  expected: string | boolean | number;
}

export interface EvaluateCallSiteInput {
  questionId: string;
  /** Built per case so a question can embed the case's own context. */
  question: (testCase: CallSiteCase) => JudgmentQuestion;
  cases: readonly CallSiteCase[];
  tier: TierLevel;
  tenantSlug?: string;
  /** Repeated runs, to measure whether the provider agrees with itself. */
  repeats?: number;
  /** The floor the call site would use. Default 0.7. */
  confidenceFloor?: number;
}

export interface CallSiteCaseResult {
  id: string;
  expected: string | boolean | number;
  actual?: string | boolean | number;
  confidence: number;
  correct: boolean;
  stable: boolean;
  error?: string;
}

export interface CallSiteEvaluation {
  questionId: string;
  providerId?: string;
  results: CallSiteCaseResult[];
  answered: number;
  accuracy: number;
  /** Answers at or above the floor — the ones a call site would act on. */
  aboveFloor: number;
  /** Of those, how many were wrong. This is the number that decides. */
  confidentlyWrong: number;
  confidentlyWrongRate: number;
  unstable: number;
  reliability: ReliabilityReport;
}

const DEFAULT_REPEATS = 3;
const DEFAULT_FLOOR = 0.7;

function answerFor(
  answers: readonly JudgmentAnswer[],
  questionId: string
): JudgmentAnswer | undefined {
  return answers.find((answer) => answer.id === questionId);
}

/** Run a labelled set through whatever provider the seam selects. */
export async function evaluateCallSite(
  input: EvaluateCallSiteInput
): Promise<CallSiteEvaluation> {
  const repeats = Math.max(1, input.repeats ?? DEFAULT_REPEATS);
  const floor = input.confidenceFloor ?? DEFAULT_FLOOR;
  const results: CallSiteCaseResult[] = [];
  let providerId: string | undefined;

  for (const testCase of input.cases) {
    const runs: Array<{ value?: string | boolean | number; confidence: number }> = [];
    let error: string | undefined;
    for (let attempt = 0; attempt < repeats; attempt++) {
      try {
        const result = await judge({
          state: testCase.state,
          questions: [input.question(testCase)],
          tier: input.tier,
          ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
        });
        providerId = result.provider_id;
        const answer = answerFor(result.answers, input.questionId);
        runs.push({ value: answer?.value, confidence: answer?.confidence ?? 0 });
      } catch (caught: any) {
        error = caught?.message || String(caught);
        break;
      }
    }

    if (error || runs.length === 0) {
      results.push({
        id: testCase.id,
        expected: testCase.expected,
        confidence: Number.NaN,
        correct: false,
        stable: false,
        error: error || 'no runs',
      });
      continue;
    }

    const stable = new Set(runs.map((run) => `${String(run.value)}|${run.confidence}`)).size === 1;
    const first = runs[0];
    results.push({
      id: testCase.id,
      expected: testCase.expected,
      actual: first.value,
      confidence: first.confidence,
      correct: first.value === testCase.expected,
      stable,
    });
  }

  const answered = results.filter((result) => !result.error);
  const aboveFloor = answered.filter((result) => result.confidence >= floor);
  const confidentlyWrong = aboveFloor.filter((result) => !result.correct);

  return {
    questionId: input.questionId,
    ...(providerId ? { providerId } : {}),
    results,
    answered: answered.length,
    accuracy: answered.length ? answered.filter((r) => r.correct).length / answered.length : NaN,
    aboveFloor: aboveFloor.length,
    confidentlyWrong: confidentlyWrong.length,
    confidentlyWrongRate: aboveFloor.length ? confidentlyWrong.length / aboveFloor.length : 0,
    unstable: answered.filter((result) => !result.stable).length,
    reliability: computeReliability(
      answered.map((result) => ({
        id: result.id,
        confidence: result.confidence,
        correct: result.correct,
        stable: result.stable,
      }))
    ),
  };
}

export interface CallSiteRecommendation {
  /** Whether this call site should demand a fit before acting. */
  requireCalibrated: boolean;
  reason: string;
}

export interface RecommendationPolicy {
  /**
   * Tolerated rate of confidently wrong answers. Default 0.10.
   *
   * Pick it from what a wrong answer costs *here*. Dropping a document from
   * a context pack is recoverable and can tolerate more; naming an error
   * category that drives an automated repair action cannot.
   */
  maxConfidentlyWrongRate?: number;
  /** Minimum answers above the floor before the rate means anything. Default 10. */
  minAboveFloor?: number;
}

/**
 * Whether a call site may act on this provider's unfitted confidence.
 *
 * Deliberately conservative: too little evidence produces `requireCalibrated`
 * exactly as a bad result does, because "we did not measure" and "we measured
 * and it was bad" should not differ in what the system is allowed to do.
 */
export function recommendRequireCalibrated(
  evaluation: CallSiteEvaluation,
  policy: RecommendationPolicy = {}
): CallSiteRecommendation {
  const maxRate = policy.maxConfidentlyWrongRate ?? 0.1;
  const minAboveFloor = policy.minAboveFloor ?? 10;

  const failures = evaluation.results.filter((result) => result.error);
  if (failures.length > 0) {
    return {
      requireCalibrated: true,
      reason: `${failures.length} of ${evaluation.results.length} cases did not produce an answer`,
    };
  }

  if (evaluation.unstable > 0) {
    return {
      requireCalibrated: true,
      reason: `${evaluation.unstable} of ${evaluation.answered} cases disagreed across repeated runs`,
    };
  }

  if (evaluation.aboveFloor < minAboveFloor) {
    return {
      requireCalibrated: true,
      reason: `only ${evaluation.aboveFloor} answers cleared the confidence floor; ${minAboveFloor} are needed before the confidently-wrong rate means anything`,
    };
  }

  if (evaluation.confidentlyWrongRate > maxRate) {
    return {
      requireCalibrated: true,
      reason: `${evaluation.confidentlyWrong} of ${evaluation.aboveFloor} confident answers were wrong (${(evaluation.confidentlyWrongRate * 100).toFixed(0)}%, above ${(maxRate * 100).toFixed(0)}%)`,
    };
  }

  return {
    requireCalibrated: false,
    reason: `${evaluation.confidentlyWrong} of ${evaluation.aboveFloor} confident answers were wrong (${(evaluation.confidentlyWrongRate * 100).toFixed(0)}%), stable across runs`,
  };
}
