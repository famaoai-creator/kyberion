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

const SCORE_WEIGHTS: Array<[keyof LeadScoreSignals, number, string]> = [
  ['has_budget', 15, '予算の見込みがある'],
  ['has_timeline', 15, '導入時期が明確'],
  ['has_decision_maker', 10, '決裁者が把握できている'],
  ['clear_pain', 20, '課題が明確'],
  ['technical_fit', 15, '技術要件との整合がある'],
  ['strategic_fit', 15, '事業要件との整合がある'],
];

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function buildReasons(signals: LeadScoreSignals): string[] {
  const reasons: string[] = [];

  if (signals.clear_pain) reasons.push('課題が明確');
  if (signals.has_timeline) reasons.push('導入期限がある');
  if (!signals.has_decision_maker) reasons.push('決裁者は未確認');
  if (signals.wrong_fit_signal) reasons.push('不適合シグナルがある');
  if (signals.has_budget && !signals.clear_pain && !signals.has_timeline) {
    reasons.push('予算確認が先行している');
  }

  return reasons;
}

export function scoreLead(signals: LeadScoreSignals): LeadScoreResult {
  let score = 0;
  for (const [key, weight] of SCORE_WEIGHTS) {
    if (signals[key]) {
      score += weight;
    }
  }

  const reasons = buildReasons(signals);

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
