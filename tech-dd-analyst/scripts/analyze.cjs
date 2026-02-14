#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
/**
 * tech-dd-analyst: Technical due diligence analysis on project directories.
 * Evaluates code quality, architecture, team maturity, and technical risk.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { getAllFiles } = require('@agent/core/fs-utils');

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Project directory to analyze',
  })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function assessCodeQuality(dir) {
  let totalFiles = 0,
    totalLines = 0;
  const languages = {};
  const allFiles = getAllFiles(dir, { maxDepth: 5 });
  for (const full of allFiles) {
    const ext = path.extname(full).toLowerCase();
    if (['.js', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb'].includes(ext)) {
      try {
        totalLines += fs.readFileSync(full, 'utf8').split('\n').length;
        totalFiles++;
        languages[ext] = (languages[ext] || 0) + 1;
      } catch (_e) {}
    }
  }
  return {
    totalFiles,
    totalLines,
    avgFileSize: totalFiles > 0 ? Math.round(totalLines / totalFiles) : 0,
    languages,
  };
}

function assessTeamMaturity(dir) {
  try {
    const authors = execSync(
      'git log --format="%an" --since="6 months ago" | sort | uniq -c | sort -rn',
      { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const contributors = authors
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const m = l.trim().match(/(\d+)\s+(.+)/);
        return m ? { commits: parseInt(m[1]), name: m[2] } : null;
      })
      .filter(Boolean);
    const totalCommits = contributors.reduce((s, c) => s + c.commits, 0);
    const busFactorThreshold = totalCommits * 0.5;
    let busFactor = 0,
      acc = 0;
    for (const c of contributors) {
      acc += c.commits;
      busFactor++;
      if (acc >= busFactorThreshold) break;
    }
    return {
      contributors: contributors.length,
      topContributors: contributors.slice(0, 5),
      busFactor,
      risk: busFactor <= 1 ? 'critical' : busFactor <= 2 ? 'high' : 'low',
    };
  } catch (_e) {
    return { contributors: 0, topContributors: [], busFactor: 0, risk: 'unknown' };
  }
}

function assessArchitecture(dir) {
  const signals = {
    hasMonorepo: false,
    hasMicroservices: false,
    hasDockerCompose: false,
    hasTerraform: false,
    hasK8s: false,
    testFramework: 'none',
    cicd: 'none',
  };
  const exists = (p) => fs.existsSync(path.join(dir, p));
  if (exists('lerna.json') || exists('pnpm-workspace.yaml') || exists('workspaces'))
    signals.hasMonorepo = true;
  if (exists('docker-compose.yml') || exists('docker-compose.yaml')) {
    signals.hasDockerCompose = true;
    signals.hasMicroservices = true;
  }
  if (exists('terraform') || exists('main.tf')) signals.hasTerraform = true;
  if (exists('k8s') || exists('kubernetes')) signals.hasK8s = true;
  if (exists('jest.config.js') || exists('jest.config.cjs')) signals.testFramework = 'jest';
  else if (exists('vitest.config.ts')) signals.testFramework = 'vitest';
  else if (exists('pytest.ini') || exists('conftest.py')) signals.testFramework = 'pytest';
  else if (exists('tests') || exists('test')) signals.testFramework = 'custom';
  if (exists('.github/workflows')) signals.cicd = 'github-actions';
  else if (exists('.gitlab-ci.yml')) signals.cicd = 'gitlab-ci';
  else if (exists('Jenkinsfile')) signals.cicd = 'jenkins';
  return signals;
}

function calculateDDScore(code, team, arch) {
  let score = 50;
  if (code.totalFiles > 10) score += 5;
  if (code.totalFiles > 100) score += 5;
  if (code.avgFileSize < 300) score += 5;
  else score -= 5;
  if (team.busFactor >= 3) score += 10;
  else if (team.busFactor <= 1) score -= 15;
  if (team.contributors >= 3) score += 5;
  if (arch.testFramework !== 'none') score += 10;
  if (arch.cicd !== 'none') score += 10;
  if (arch.hasTerraform || arch.hasK8s) score += 5;
  return Math.max(0, Math.min(100, score));
}

runSkill('tech-dd-analyst', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const code = assessCodeQuality(targetDir);
  const team = assessTeamMaturity(targetDir);
  const arch = assessArchitecture(targetDir);
  const score = calculateDDScore(code, team, arch);

  let verdict = 'fail';
  if (score >= 80) verdict = 'strong_pass';
  else if (score >= 60) verdict = 'pass';
  else if (score >= 40) verdict = 'conditional_pass';

  const risks = [];
  if (team.risk === 'critical')
    risks.push({
      area: 'Team',
      severity: 'critical',
      detail: `Bus factor is ${team.busFactor} - key person dependency`,
    });
  if (arch.testFramework === 'none')
    risks.push({ area: 'Quality', severity: 'high', detail: 'No test framework detected' });
  if (arch.cicd === 'none')
    risks.push({ area: 'DevOps', severity: 'high', detail: 'No CI/CD pipeline detected' });
  if (code.avgFileSize > 500)
    risks.push({
      area: 'Maintainability',
      severity: 'medium',
      detail: `Average file size ${code.avgFileSize} lines - hard to maintain`,
    });

  const result = {
    directory: targetDir,
    score,
    verdict,
    codeQuality: code,
    teamMaturity: team,
    architecture: arch,
    risks,
    recommendations: risks.map((r) => `[${r.severity}] ${r.area}: ${r.detail}`),
  };

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
