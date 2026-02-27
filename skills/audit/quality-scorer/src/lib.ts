export interface ScoringRules {
  min_length: { threshold: number; penalty: number; message: string };
  max_length?: { threshold: number; penalty: number; message: string };
  avg_sentence_length?: { threshold: number; penalty: number; message: string };
  complexity?: { threshold: number; penalty: number; message: string };
}

export interface QualityMetrics {
  charCount: number;
  sentences: number;
  avgLen: number;
  complexity: number;
}

export interface ScoreResult {
  score: number;
  metrics: QualityMetrics;
  issues: string[];
}

export const DEFAULT_RULES: ScoringRules = {
  min_length: { threshold: 100, penalty: 20, message: 'Content is too short.' },
  complexity: { threshold: 15, penalty: 10, message: 'Content is too complex.' },
};

export function estimateComplexity(content: string): number {
  // SCAP Layer 2: Cyclomatic Complexity Estimation
  const matches = content.match(/if|for|while|case|&&|\|\|/g);
  return matches ? matches.length : 0;
}

export function calculateScore(content: string, rules: ScoringRules = DEFAULT_RULES): ScoreResult {
  const charCount = content.length;
  const sentences = content.split(/[.?!。？！]/).filter(Boolean).length;
  const avgLen = sentences > 0 ? charCount / sentences : 0;
  const complexity = estimateComplexity(content);

  let score = 100;
  const issues: string[] = [];

  if (charCount < rules.min_length.threshold) {
    score -= rules.min_length.penalty;
    issues.push(rules.min_length.message);
  }

  if (rules.max_length && charCount > rules.max_length.threshold) {
    score -= rules.max_length.penalty;
    issues.push(rules.max_length.message);
  }

  if (rules.complexity && complexity > rules.complexity.threshold) {
    score -= rules.complexity.penalty;
    issues.push(rules.complexity.message);
  }

  return {
    score: Math.max(0, score),
    metrics: { charCount, sentences, avgLen, complexity },
    issues,
  };
}
