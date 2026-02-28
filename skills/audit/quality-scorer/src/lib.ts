import fs from 'fs';
import path from 'path';

export interface ScoringRules {
  min_length: { threshold: number; penalty: number; message: string };
  max_length?: { threshold: number; penalty: number; message: string };
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

function loadThresholds() {
  const rootDir = process.cwd();
  const pathRules = path.resolve(rootDir, 'knowledge/skills/common/governance-thresholds.json');
  return JSON.parse(fs.readFileSync(pathRules, 'utf8'));
}

export function estimateComplexity(content: string): number {
  const matches = content.match(/if|for|while|case|&&|\|\|/g);
  return matches ? matches.length : 0;
}

export function calculateScore(content: string, customRules?: ScoringRules): ScoreResult {
  const thresholds = loadThresholds().quality;
  const rules = customRules || {
    min_length: { threshold: 100, penalty: 20, message: 'Content is too short.' },
    complexity: { threshold: 15, penalty: 10, message: 'Content is too complex.' }
  };

  const charCount = content.length;
  const sentences = content.split(/[.?!。？！]/).filter(Boolean).length;
  const avgLen = sentences > 0 ? charCount / sentences : 0;
  const complexity = estimateComplexity(content);

  let score = thresholds.base_score;
  const issues: string[] = [];

  if (charCount < rules.min_length.threshold) {
    score -= rules.min_length.penalty;
    issues.push(rules.min_length.message);
  }
  if (rules.complexity && complexity > rules.complexity.threshold) {
    score -= rules.complexity.penalty;
    issues.push(rules.complexity.message);
  }

  return { score: Math.max(0, score), metrics: { charCount, sentences, avgLen, complexity }, issues };
}
