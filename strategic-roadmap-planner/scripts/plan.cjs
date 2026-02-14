#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * strategic-roadmap-planner: Analyzes code complexity, technical debt,
 * and project state to propose a 3-month strategic roadmap.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Project directory to analyze',
  })
  .option('months', {
    alias: 'm',
    type: 'number',
    default: 3,
    description: 'Planning horizon in months',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help().argv;

function analyzeCodeComplexity(dir) {
  const stats = { totalFiles: 0, totalLines: 0, avgFileSize: 0, largeFiles: [], languages: {} };
  const allFiles = getAllFiles(dir, { maxDepth: 5 });
  for (const full of allFiles) {
    const ext = path.extname(full).toLowerCase();
    if (
      ![
        '.js',
        '.cjs',
        '.mjs',
        '.ts',
        '.tsx',
        '.jsx',
        '.py',
        '.go',
        '.rs',
        '.java',
        '.rb',
        '.php',
      ].includes(ext)
    )
      continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n').length;
      stats.totalFiles++;
      stats.totalLines += lines;
      stats.languages[ext] = (stats.languages[ext] || 0) + 1;
      if (lines > 300) stats.largeFiles.push({ file: path.relative(dir, full), lines });
    } catch (_e) {
      /* skip */
    }
  }
  stats.avgFileSize = stats.totalFiles > 0 ? Math.round(stats.totalLines / stats.totalFiles) : 0;
  stats.largeFiles.sort((a, b) => b.lines - a.lines);
  stats.largeFiles = stats.largeFiles.slice(0, 10);
  return stats;
}

function detectTechDebt(dir) {
  const indicators = [];
  function scanFile(filePath, content) {
    const lower = content.toLowerCase();
    const rel = path.relative(dir, filePath);
    const todoCount = (lower.match(/\btodo\b/g) || []).length;
    const hackCount = (lower.match(/\bhack\b/g) || []).length;
    const fixmeCount = (lower.match(/\bfixme\b/g) || []).length;
    const deprecatedCount = (lower.match(/\bdeprecated\b/g) || []).length;
    if (todoCount + hackCount + fixmeCount + deprecatedCount > 0) {
      indicators.push({
        file: rel,
        todos: todoCount,
        hacks: hackCount,
        fixmes: fixmeCount,
        deprecated: deprecatedCount,
      });
    }
  }
  const allFiles = getAllFiles(dir, { maxDepth: 5 });
  for (const full of allFiles) {
    if (path.basename(full).match(/\.(js|cjs|mjs|ts|tsx|py|go|rs|java)$/)) {
      try {
        scanFile(full, fs.readFileSync(full, 'utf8'));
      } catch (_e) {
        /* skip */
      }
    }
  }
  const totalTodos = indicators.reduce((s, i) => s + i.todos, 0);
  const totalHacks = indicators.reduce((s, i) => s + i.hacks, 0);
  const totalFixmes = indicators.reduce((s, i) => s + i.fixmes, 0);
  return {
    totalTodos,
    totalHacks,
    totalFixmes,
    debtScore: Math.min(100, totalTodos * 2 + totalHacks * 5 + totalFixmes * 3),
    hotspots: indicators
      .sort((a, b) => b.todos + b.hacks + b.fixmes - (a.todos + a.hacks + a.fixmes))
      .slice(0, 10),
  };
}

function getRecentVelocity(dir) {
  try {
    const weeks4 = execSync('git log --oneline --since="4 weeks ago" --no-merges', {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const weeks1 = execSync('git log --oneline --since="1 week ago" --no-merges', {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const total = weeks4.trim().split('\n').filter(Boolean).length;
    const recent = weeks1.trim().split('\n').filter(Boolean).length;
    return { commitsLast4Weeks: total, commitsLastWeek: recent, avgPerWeek: Math.round(total / 4) };
  } catch (_e) {
    return { commitsLast4Weeks: 0, commitsLastWeek: 0, avgPerWeek: 0 };
  }
}

function checkInfrastructure(dir) {
  const checks = {
    hasCICD: false,
    hasTests: false,
    hasLinting: false,
    hasTypeChecking: false,
    hasDocumentation: false,
    hasContainerization: false,
  };
  const exists = (p) => fs.existsSync(path.join(dir, p));
  checks.hasCICD = exists('.github/workflows') || exists('.gitlab-ci.yml') || exists('Jenkinsfile');
  checks.hasTests = exists('tests') || exists('test') || exists('__tests__') || exists('spec');
  checks.hasLinting =
    exists('.eslintrc.js') ||
    exists('.eslintrc.json') ||
    exists('eslint.config.mjs') ||
    exists('.pylintrc');
  checks.hasTypeChecking =
    exists('tsconfig.json') || exists('mypy.ini') || exists('pyrightconfig.json');
  checks.hasDocumentation = exists('README.md') || exists('docs');
  checks.hasContainerization = exists('Dockerfile') || exists('docker-compose.yml');
  return checks;
}

function generateRoadmap(complexity, debt, velocity, infra, months) {
  const phases = [];
  const priorities = [];

  // Phase 1: Foundation (Month 1)
  const p1Items = [];
  if (debt.debtScore > 30) p1Items.push('Address top tech debt hotspots (TODOs, FIXMEs)');
  if (!infra.hasTests) p1Items.push('Establish test suite and coverage baseline');
  if (!infra.hasLinting) p1Items.push('Set up linting and code standards');
  if (!infra.hasCICD) p1Items.push('Configure CI/CD pipeline');
  if (p1Items.length === 0) p1Items.push('Code quality review and optimization');
  phases.push({ month: 1, phase: 'Foundation & Stabilization', items: p1Items });

  // Phase 2: Growth (Month 2)
  const p2Items = [];
  if (!infra.hasTypeChecking) p2Items.push('Add type checking for improved maintainability');
  if (complexity.largeFiles.length > 0)
    p2Items.push(`Refactor ${complexity.largeFiles.length} large files (>300 lines)`);
  if (!infra.hasDocumentation) p2Items.push('Create/improve project documentation');
  p2Items.push('Feature development sprint based on backlog priority');
  phases.push({ month: 2, phase: 'Growth & Feature Development', items: p2Items });

  // Remaining months
  for (let m = 3; m <= months; m++) {
    const items = [
      'Performance optimization and monitoring',
      'Security hardening and dependency updates',
    ];
    if (!infra.hasContainerization && m === 3)
      items.push('Containerization and deployment automation');
    items.push('Technical roadmap review and adjustment');
    phases.push({ month: m, phase: `Scaling & Optimization (Month ${m})`, items });
  }

  // Priorities
  if (debt.debtScore > 50)
    priorities.push({
      priority: 'critical',
      action: `Tech debt score ${debt.debtScore}/100 - allocate 30% capacity to debt reduction`,
    });
  if (velocity.avgPerWeek < 5)
    priorities.push({
      priority: 'high',
      action: 'Low velocity detected - review blockers and process efficiency',
    });
  if (complexity.avgFileSize > 200)
    priorities.push({
      priority: 'medium',
      action: `Average file size ${complexity.avgFileSize} lines - consider modularization`,
    });

  return { phases, priorities };
}

runSkill('strategic-roadmap-planner', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const complexity = analyzeCodeComplexity(targetDir);
  const debt = detectTechDebt(targetDir);
  const velocity = getRecentVelocity(targetDir);
  const infra = checkInfrastructure(targetDir);
  const roadmap = generateRoadmap(complexity, debt, velocity, infra, argv.months);

  const result = {
    directory: targetDir,
    planningHorizon: `${argv.months} months`,
    codeAnalysis: {
      totalFiles: complexity.totalFiles,
      totalLines: complexity.totalLines,
      avgFileSize: complexity.avgFileSize,
      languages: complexity.languages,
      largeFiles: complexity.largeFiles.slice(0, 5),
    },
    techDebt: debt,
    velocity,
    infrastructure: infra,
    roadmap: roadmap.phases,
    priorities: roadmap.priorities,
  };

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
