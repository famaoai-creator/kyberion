#!/usr/bin/env node
/**
 * quality-scorer/scripts/score.ts
 * Advanced Scorer - SCAP Layer 2 & 3 Compliance.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { requireArgs, validateFilePath } from '@agent/core/validators';

interface ScoringRules {
  min_length: { threshold: number; penalty: number; message: string };
  max_length: { threshold: number; penalty: number; message: string };
  avg_sentence_length: { threshold: number; penalty: number; message: string };
  complexity?: { threshold: number; penalty: number; message: string };
}

function estimateComplexity(content: string): number {
  // SCAP Layer 2: Cyclomatic Complexity Estimation
  const matches = content.match(/if|for|while|case|&&|\|\|/g);
  return matches ? matches.length : 0;
}

runSkill('quality-scorer', () => {
  const argv = requireArgs(['input']);
  const inputPath = validateFilePath(argv.input);
  const content = fs.readFileSync(inputPath, 'utf8');

  // 1. Load Knowledge
  const rulesPath = path.resolve(__dirname, '../../knowledge/skills/quality-scorer/rules.json');
  const { scoring_rules } = JSON.parse(fs.readFileSync(rulesPath, 'utf8')) as {
    scoring_rules: ScoringRules;
  };

  // 2. Metric Calculation
  const charCount = content.length;
  const sentences = content.split(/[.?!。？！]/).filter(Boolean).length;
  const avgLen = sentences > 0 ? charCount / sentences : 0;
  const complexity = estimateComplexity(content);

  // 3. Scoring
  let score = 100;
  const issues: string[] = [];

  if (charCount < scoring_rules.min_length.threshold) {
    score -= scoring_rules.min_length.penalty;
    issues.push(scoring_rules.min_length.message);
  }
  if (complexity > (scoring_rules.complexity?.threshold || 15)) {
    score -= scoring_rules.complexity?.penalty || 10;
    issues.push(scoring_rules.complexity?.message || 'Code logic is too complex.');
  }

  return {
    status: 'scored',
    score: Math.max(0, score),
    metrics: { charCount, complexity, avgLen },
    compliance: 'SCAP-Layer-2',
    issues,
  };
});
