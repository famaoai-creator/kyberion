import { clamp } from './foundation/text.js';
import type { SupportedLocale } from './locale-normalize.js';
import { t } from './t.js';

export interface LeadScoreSignals {
  has_budget: boolean;
  has_timeline: boolean;
  has_decision_maker: boolean;
  clear_pain: boolean;
  technical_fit: boolean;
  strategic_fit: boolean;
  wrong_fit_signal: boolean;
}

export type LeadScoreGrade = 'high_intent' | 'exploratory' | 'price_shopping' | 'wrong_fit';

export interface LeadScoreResult {
  score: number;
  grade: LeadScoreGrade;
  signals: LeadScoreSignals;
  reasons: string[];
}

const SCORE_WEIGHTS: Array<[keyof LeadScoreSignals, number]> = [
  ['has_budget', 15],
  ['has_timeline', 15],
  ['has_decision_maker', 10],
  ['clear_pain', 20],
  ['technical_fit', 15],
  ['strategic_fit', 15],
];

const clampScore = (score: number): number => clamp(score, 0, 100);

function buildReasons(signals: LeadScoreSignals, locale?: SupportedLocale): string[] {
  const reasons: string[] = [];

  if (signals.clear_pain) reasons.push(t('lead_score:reason_clear_pain', undefined, locale));
  if (signals.has_timeline) reasons.push(t('lead_score:reason_has_timeline', undefined, locale));
  if (!signals.has_decision_maker)
    reasons.push(t('lead_score:reason_no_decision_maker', undefined, locale));
  if (signals.wrong_fit_signal) reasons.push(t('lead_score:reason_wrong_fit', undefined, locale));
  if (signals.has_budget && !signals.clear_pain && !signals.has_timeline) {
    reasons.push(t('lead_score:reason_budget_first', undefined, locale));
  }

  return reasons;
}

export function scoreLead(signals: LeadScoreSignals, locale?: SupportedLocale): LeadScoreResult {
  let score = 0;
  for (const [key, weight] of SCORE_WEIGHTS) {
    if (signals[key]) {
      score += weight;
    }
  }

  const reasons = buildReasons(signals, locale);

  if (signals.wrong_fit_signal) {
    return {
      score: clampScore(Math.min(score, 20)),
      grade: 'wrong_fit',
      signals,
      reasons,
    };
  }

  const looksLikePriceShopping = signals.has_budget && !signals.clear_pain && !signals.has_timeline;
  if (looksLikePriceShopping) {
    return {
      score: clampScore(Math.max(score, 35)),
      grade: 'price_shopping',
      signals,
      reasons,
    };
  }

  if (score >= 75) {
    return {
      score: clampScore(score),
      grade: 'high_intent',
      signals,
      reasons,
    };
  }

  if (score < 30) {
    return {
      score: clampScore(score),
      grade: 'wrong_fit',
      signals,
      reasons,
    };
  }

  return {
    score: clampScore(score),
    grade: 'exploratory',
    signals,
    reasons,
  };
}
