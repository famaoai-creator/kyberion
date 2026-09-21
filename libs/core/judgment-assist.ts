/**
 * The one place a judgment is allowed to influence anything.
 *
 * Every integration of the `judgment-backend` seam goes through
 * `assistWithJudgment`, so the rules that keep a model from breaking the
 * system are written once, tested once, and cannot be forgotten at a call
 * site:
 *
 * - **The deterministic path is authoritative.** A judgment supplies a
 *   `baseline` it may refine. Everything below returns the baseline.
 * - **It never throws.** No provider, a provider that throws, one that hangs,
 *   a malformed answer, a question nobody supports — all of it is a baseline
 *   with a reason, not an error reaching the caller.
 * - **It is bounded in time.** A judgment is a 24ms local call or it is not
 *   worth making; `timeoutMs` caps it so a wedged worker cannot stall a
 *   pipeline.
 * - **Low confidence declines.** Below `minConfidence` the baseline stands.
 * - **`requireCalibrated` is available and, today, always declines.** Nothing
 *   is calibrated yet (see judgment-backend-seam.md), so a call site that
 *   asks for calibration gets the baseline until a fit exists. That is the
 *   point: a site that must not act on an uncalibrated number says so in
 *   code rather than in a comment.
 * - **`accept` may refuse.** The caller maps an answer to its own type and
 *   returns `undefined` to keep the baseline, which is where a monotonicity
 *   rule lives: a security-adjacent site accepts a judgment that *adds* a
 *   restriction and refuses one that removes it.
 *
 * What this deliberately does not do is decide. It returns a value and the
 * reason it chose it; routing stays in `judge-route.ts`.
 */

import { judge, type JudgmentAnswer, type JudgmentQuestion } from './judgment-backend.js';
import { createLogger } from './logger.js';
import type { TierLevel } from './types.js';

const logger = createLogger('judgment-assist');

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MIN_CONFIDENCE = 0.7;

export interface JudgmentAssistInput<T> {
  /** What the deterministic path already decided. Returned unless refined. */
  baseline: T;
  /** The material to judge. */
  state: string;
  /** Asked together in one call when a provider supports it. */
  questions: readonly JudgmentQuestion[];
  /** Highest data tier in `state`; decides which providers may see it. */
  tier: TierLevel;
  tenantSlug?: string;
  /**
   * Map answers onto the caller's type. Return `undefined` to keep the
   * baseline — this is where a call site refuses an answer it should not
   * act on, such as one that would loosen a restriction.
   */
  accept(answers: readonly JudgmentAnswer[], baseline: T): T | undefined;
  /** Below this, the baseline stands. Default 0.7. */
  minConfidence?: number;
  /** Refuse any answer that is not a fitted estimate. Default false. */
  requireCalibrated?: boolean;
  /** Cap on the whole judgment. Default 2000ms. */
  timeoutMs?: number;
  /** Short label for logs and the returned reason. */
  label?: string;
}

export interface JudgmentAssistResult<T> {
  value: T;
  source: 'baseline' | 'judgment';
  /** Deterministic explanation; safe to log and to put in evidence. */
  reason: string;
  /** Present when a provider answered, even if its answer was declined. */
  answers?: readonly JudgmentAnswer[];
  provider_id?: string;
}

function baselineResult<T>(baseline: T, reason: string): JudgmentAssistResult<T> {
  return { value: baseline, source: 'baseline', reason };
}

/**
 * Refine `baseline` with a judgment, or keep it. Never rejects.
 */
export async function assistWithJudgment<T>(
  input: JudgmentAssistInput<T>
): Promise<JudgmentAssistResult<T>> {
  const label = input.label || input.questions[0]?.id || 'judgment';
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!input.state?.trim()) return baselineResult(input.baseline, `${label}: empty state`);
  if (!input.questions?.length) return baselineResult(input.baseline, `${label}: no questions`);

  let result: Awaited<ReturnType<typeof judge>>;
  try {
    result = await withTimeout(
      judge({
        state: input.state,
        questions: input.questions,
        tier: input.tier,
        ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
      }),
      timeoutMs,
      label
    );
  } catch (error: any) {
    // Includes "no provider registered": not having a model is the normal
    // state of this repo, not an incident.
    const reason = `${label}: judgment unavailable (${error?.message || error})`;
    logger.debug(`[judgment-assist] ${reason}`);
    return baselineResult(input.baseline, reason);
  }

  const answers = result.answers || [];
  if (answers.length === 0) {
    return { ...baselineResult(input.baseline, `${label}: no answers`), provider_id: result.provider_id };
  }

  if (input.requireCalibrated) {
    const uncalibrated = answers.filter((answer) => !answer.calibrated);
    if (uncalibrated.length > 0) {
      return {
        ...baselineResult(
          input.baseline,
          `${label}: '${result.provider_id}' is not calibrated for ${uncalibrated
            .map((answer) => answer.id)
            .join(', ')}; baseline kept`
        ),
        answers,
        provider_id: result.provider_id,
      };
    }
  }

  const weak = answers.filter((answer) => answer.confidence < minConfidence);
  if (weak.length > 0) {
    return {
      ...baselineResult(
        input.baseline,
        `${label}: confidence below ${minConfidence} for ${weak
          .map((answer) => `${answer.id}=${answer.confidence.toFixed(2)}`)
          .join(', ')}`
      ),
      answers,
      provider_id: result.provider_id,
    };
  }

  let accepted: T | undefined;
  try {
    accepted = input.accept(answers, input.baseline);
  } catch (error: any) {
    // A caller's mapping throwing must not be worse than having no model.
    const reason = `${label}: accept() threw (${error?.message || error}); baseline kept`;
    logger.warn(`[judgment-assist] ${reason}`);
    return { ...baselineResult(input.baseline, reason), answers, provider_id: result.provider_id };
  }

  if (accepted === undefined) {
    return {
      ...baselineResult(input.baseline, `${label}: caller declined the answer`),
      answers,
      provider_id: result.provider_id,
    };
  }

  return {
    value: accepted,
    source: 'judgment',
    reason: `${label}: accepted from '${result.provider_id}' (${result.reason})`,
    answers,
    provider_id: result.provider_id,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Convenience for the common single-choice shape. */
export function choiceAnswer(
  answers: readonly JudgmentAnswer[],
  questionId: string
): JudgmentAnswer | undefined {
  const answer = answers.find((candidate) => candidate.id === questionId);
  return answer && typeof answer.value === 'string' ? answer : undefined;
}
