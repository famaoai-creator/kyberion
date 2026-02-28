import fs from 'fs';
import path from 'path';

export interface CheckConfig {
  name: string;
  patterns: string[];
  weight: number;
  message: string;
}

export interface CheckResult {
  check: string;
  status: 'found' | 'missing';
  match?: string;
  suggestion?: string;
  weight: number;
}

export interface AuditReport {
  projectRoot: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  checks: CheckResult[];
}

function loadThresholds() {
  const rootDir = process.cwd();
  const pathRules = path.resolve(rootDir, 'knowledge/skills/common/governance-thresholds.json');
  return JSON.parse(fs.readFileSync(pathRules, 'utf8'));
}

export const CHECKS: Record<string, CheckConfig> = {
  ci: { name: 'CI/CD Pipelines', patterns: ['.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile'], weight: 25, message: 'Automated pipelines ensure safety.' },
  test: { name: 'Testing Framework', patterns: ['jest.config.*', 'pytest.ini', 'package.json'], weight: 25, message: 'Tests prevent regressions.' },
  lint: { name: 'Linting & Formatting', patterns: ['.eslintrc*', '.prettierrc*'], weight: 15, message: 'Consistent style reduces cognitive load.' },
  iac: { name: 'Containerization & IaC', patterns: ['Dockerfile', 'docker-compose.yml', 'terraform/'], weight: 20, message: 'IaC ensures reproducible environments.' },
  docs: { name: 'Documentation', patterns: ['README.md', 'docs/'], weight: 15, message: 'Docs lower onboarding cost.' },
};

export function checkExistence(projectRoot: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const fullPath = path.join(projectRoot, pattern.endsWith('/') ? pattern.slice(0, -1) : pattern);
    if (fs.existsSync(fullPath)) return pattern;
  }
  return null;
}

export function performAudit(projectRoot: string): AuditReport {
  const thresholds = loadThresholds().project_health;
  let totalScore = 0;
  let maxScore = 0;
  const results: CheckResult[] = [];

  Object.entries(CHECKS).forEach(([key, config]) => {
    maxScore += config.weight;
    let found = checkExistence(projectRoot, config.patterns);
    if (found) {
      totalScore += config.weight;
      results.push({ check: config.name, status: 'found', match: found, weight: config.weight });
    } else {
      results.push({ check: config.name, status: 'missing', suggestion: config.message, weight: config.weight });
    }
  });

  const percentage = Math.round((totalScore / maxScore) * 100);
  let grade: AuditReport['grade'] = 'F';
  if (percentage >= 90) grade = 'A';
  else if (percentage >= 80) grade = 'B';
  else if (percentage >= 60) grade = 'C';
  else if (percentage >= 40) grade = 'D';

  return { projectRoot, score: percentage, grade, checks: results };
}
