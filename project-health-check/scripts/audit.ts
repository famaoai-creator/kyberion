#!/usr/bin/env node
/**
 * project-health-check/scripts/audit.ts
 * Standardized Health Audit (TypeScript Version)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '../../scripts/lib/skill-wrapper.cjs';
import { requireArgs } from '../../scripts/lib/validators.cjs';

// --- Types ---
export interface CheckConfig {
  name: string;
  patterns: string[];
  weight: number;
  message: string;
}

export type ChecksMap = Record<string, CheckConfig>;

export interface CheckResult {
  check: string;
  status: 'found' | 'missing';
  match?: string;
  suggestion?: string;
  weight: number;
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface AuditReport {
  projectRoot: string;
  score: number;
  grade: Grade;
  checks: CheckResult[];
}

// --- Config ---
const CHECKS: ChecksMap = {
  ci: { name: 'CI/CD Pipelines', patterns: ['.github/workflows', '.gitlab-ci.yml'], weight: 25, message: 'Automated pipelines ensure safety.' },
  test: { name: 'Testing Framework', patterns: ['jest.config.*', 'package.json'], weight: 25, message: 'Tests prevent regressions.' },
  lint: { name: 'Linting & Formatting', patterns: ['.eslintrc*', '.prettierrc*'], weight: 15, message: 'Style analysis reduces bugs.' },
  iac: { name: 'Containerization & IaC', patterns: ['Dockerfile', 'docker-compose.yml', 'terraform/'], weight: 20, message: 'IaC ensures reproducibility.' },
  docs: { name: 'Documentation', patterns: ['README.md', 'CONTRIBUTING.md'], weight: 15, message: 'Docs lower onboarding cost.' },
};

// --- Logic ---
function deriveGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

runSkill('project-health-check', () => {
  const args = requireArgs(['dir']);
  const projectRoot = path.resolve(args.dir);
  
  let totalScore = 0;
  let maxScore = 0;
  const results: CheckResult[] = [];

  for (const [key, config] of Object.entries(CHECKS)) {
    maxScore += config.weight;
    let found = false;
    let matchPath = '';

    for (const pattern of config.patterns) {
      const p = path.join(projectRoot, pattern);
      if (fs.existsSync(p)) {
        found = true;
        matchPath = pattern;
        break;
      }
    }

    if (found) {
      totalScore += config.weight;
      results.push({ check: config.name, status: 'found', match: matchPath, weight: config.weight });
    } else {
      results.push({ check: config.name, status: 'missing', suggestion: config.message, weight: config.weight });
    }
  }

  const score = Math.round((totalScore / maxScore) * 100);
  
  return {
    projectRoot,
    score,
    grade: deriveGrade(score),
    checks: results
  };
});
