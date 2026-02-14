const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { fileUtils } = require('../../scripts/lib/core.cjs');

const projectRoot = process.cwd();

// --- Configuration ---

const CHECKS = {
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

// --- Helpers ---

function checkExistence(patterns) {
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      const dirPath = path.join(projectRoot, pattern.slice(0, -1));
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) return pattern;
    } else if (pattern.includes('*')) {
      const dir = path.dirname(pattern);
      const base = path.basename(pattern);
      try {
        const files = fs.readdirSync(path.join(projectRoot, dir === '.' ? '' : dir));
        const regex = new RegExp('^' + base.replace('.', '\.').replace('*', '.*') + '$');
        const match = files.find((f) => regex.test(f));
        if (match) return match;
      } catch (_e) {
        /* directory does not exist */
      }
    } else {
      if (fs.existsSync(path.join(projectRoot, pattern))) return pattern;
    }
  }
  return null;
}

function checkPackageJson(type) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;

  try {
    const pkg = fileUtils.readJson(pkgPath);
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

// --- Main ---

runSkill('project-health-check', () => {
  let totalScore = 0;
  let maxScore = 0;
  const results = [];

  Object.entries(CHECKS).forEach(([key, config]) => {
    maxScore += config.weight;
    let found = checkExistence(config.patterns);

    if (!found && (key === 'test' || key === 'lint')) {
      if (checkPackageJson(key)) found = 'package.json (dependencies/scripts)';
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
  let grade = 'F';
  if (percentage >= 90) grade = 'A';
  else if (percentage >= 80) grade = 'B';
  else if (percentage >= 60) grade = 'C';
  else if (percentage >= 40) grade = 'D';

  return { projectRoot, score: percentage, grade, checks: results };
});
