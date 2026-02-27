import * as fs from 'fs';
import * as path from 'path';

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

export const CHECKS: Record<string, CheckConfig> = {
  ci: {
    name: 'CI/CD Pipelines',
    patterns: [
      '.github/workflows',
      '.gitlab-ci.yml',
      '.circleci/config.yml',
      'azure-pipelines.yml',
      'bitbucket-pipelines.yml',
      'Jenkinsfile',
    ],
    weight: 25,
    message: 'Automated pipelines ensure code integration and deployment safety.',
  },
  test: {
    name: 'Testing Framework',
    patterns: [
      'jest.config.*',
      'pytest.ini',
      '.rspec',
      'pom.xml',
      'build.gradle*',
      'go.mod',
      'Cargo.toml',
      'requirements-dev.txt',
      'package.json',
    ],
    weight: 25,
    message: 'Tests prevent regressions and enable confident refactoring.',
  },
  lint: {
    name: 'Linting & Formatting',
    patterns: [
      '.eslintrc*',
      '.prettierrc*',
      'pyproject.toml',
      '.rubocop.yml',
      'checkstyle.xml',
      '.golangci.yml',
    ],
    weight: 15,
    message: 'Consistent style and static analysis reduce bugs and cognitive load.',
  },
  iac: {
    name: 'Containerization & IaC',
    patterns: [
      'Dockerfile',
      'docker-compose.yml',
      'Compose.yaml',
      'k8s/',
      'helm/',
      'terraform/',
      'main.tf',
      'Pulumi.yaml',
      'serverless.yml',
    ],
    weight: 20,
    message: 'Infrastructure as Code and Containers ensure reproducible environments.',
  },
  docs: {
    name: 'Documentation',
    patterns: ['README.md', 'CONTRIBUTING.md', 'docs/', 'doc/'],
    weight: 15,
    message: 'Good documentation lowers onboarding cost and explains "Why".',
  },
};

export function checkExistence(projectRoot: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      const dirPath = path.join(projectRoot, pattern.slice(0, -1));
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) return pattern;
    } else if (pattern.includes('*')) {
      const dir = path.dirname(pattern);
      const base = path.basename(pattern);
      try {
        const searchDir = path.join(projectRoot, dir === '.' ? '' : dir);
        if (fs.existsSync(searchDir)) {
          const files = fs.readdirSync(searchDir);
          const regex = new RegExp('^' + base.replace(/\./g, '\.').replace(/\*/g, '.*') + '$');
          const match = files.find((f) => regex.test(f));
          if (match) return match;
        }
      } catch (_e) {
        /* directory does not exist or error */
      }
    } else {
      if (fs.existsSync(path.join(projectRoot, pattern))) return pattern;
    }
  }
  return null;
}

export function checkPackageJson(projectRoot: string, type: string): boolean {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts || {};

    if (type === 'test') {
      return (
        Object.keys(allDeps).some(
          (d) =>
            d.includes('jest') || d.includes('mocha') || d.includes('vitest') || d.includes('ava')
        ) || Object.keys(scripts).some((s) => s === 'test')
      );
    }
    if (type === 'lint') {
      return (
        Object.keys(allDeps).some(
          (d) => d.includes('eslint') || d.includes('prettier') || d.includes('stylelint')
        ) || Object.keys(scripts).some((s) => s.includes('lint') || s.includes('format'))
      );
    }
  } catch (_e) {
    return false;
  }
  return false;
}

export function performAudit(projectRoot: string): AuditReport {
  let totalScore = 0;
  let maxScore = 0;
  const results: CheckResult[] = [];

  Object.entries(CHECKS).forEach(([key, config]) => {
    maxScore += config.weight;
    let found = checkExistence(projectRoot, config.patterns);

    if (!found && (key === 'test' || key === 'lint')) {
      if (checkPackageJson(projectRoot, key)) found = 'package.json (dependencies/scripts)';
    }

    if (found) {
      totalScore += config.weight;
      results.push({ check: config.name, status: 'found', match: found, weight: config.weight });
    } else {
      results.push({
        check: config.name,
        status: 'missing',
        suggestion: config.message,
        weight: config.weight,
      });
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
