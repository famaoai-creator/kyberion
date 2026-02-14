#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: process.cwd(),
    describe: 'Project root directory',
  })
  .option('skill', { alias: 's', type: 'string', describe: 'Audit a single skill by name' })
  .option('min-score', {
    type: 'number',
    default: 0,
    describe: 'Minimum passing score (0-12)',
  }).argv;

const rootDir = path.resolve(argv.dir);
const unitTestPath = path.join(rootDir, 'tests/unit.test.cjs');
const integrationTestPath = path.join(rootDir, 'tests/integration.test.cjs');

function getSkillDirs() {
  return fs.readdirSync(rootDir).filter((name) => {
    const skillMd = path.join(rootDir, name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) return false;
    const content = fs.readFileSync(skillMd, 'utf8');
    return /^status:\s*implemented/m.test(content);
  });
}

function auditSkill(skillName) {
  const skillDir = path.join(rootDir, skillName);
  const scriptsDir = path.join(skillDir, 'scripts');
  const checks = [];

  // Helper: read first .cjs script content
  function getMainScript() {
    if (!fs.existsSync(scriptsDir)) return null;
    const scripts = fs.readdirSync(scriptsDir).filter((f) => /\.(cjs|js)$/.test(f));
    if (scripts.length === 0) return null;
    return fs.readFileSync(path.join(scriptsDir, scripts[0]), 'utf8');
  }

  const scriptContent = getMainScript();

  // 1. SKILL.md exists with valid frontmatter
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const skillMdExists = fs.existsSync(skillMdPath);
  let skillMdContent = '';
  if (skillMdExists) skillMdContent = fs.readFileSync(skillMdPath, 'utf8');
  checks.push({
    name: 'skill-md-valid',
    label: 'SKILL.md has valid frontmatter',
    passed:
      skillMdExists &&
      /^name:\s*.+$/m.test(skillMdContent) &&
      /^description:\s*.+$/m.test(skillMdContent) &&
      /^status:\s*implemented/m.test(skillMdContent),
  });

  // 2. SKILL.md has Troubleshooting section
  checks.push({
    name: 'troubleshooting-docs',
    label: 'SKILL.md has Troubleshooting section',
    passed: skillMdContent.includes('## Troubleshooting'),
  });

  // 3. SKILL.md has Usage section
  checks.push({
    name: 'usage-docs',
    label: 'SKILL.md has Usage section',
    passed: skillMdContent.includes('## Usage'),
  });

  // 4. Has package.json
  checks.push({
    name: 'package-json',
    label: 'Has package.json',
    passed: fs.existsSync(path.join(skillDir, 'package.json')),
  });

  // 5. Has scripts directory with at least one .cjs file
  checks.push({
    name: 'script-exists',
    label: 'Has executable script',
    passed: scriptContent !== null,
  });

  // 6. Uses runSkill/runSkillAsync wrapper
  checks.push({
    name: 'skill-wrapper',
    label: 'Uses skill-wrapper (runSkill/runSkillAsync)',
    passed:
      scriptContent !== null &&
      (scriptContent.includes('runSkill') || scriptContent.includes('runSkillAsync')),
  });

  // 7. Uses yargs for CLI
  checks.push({
    name: 'yargs-cli',
    label: 'Uses yargs for CLI arguments',
    passed: scriptContent !== null && scriptContent.includes('yargs'),
  });

  // 8. Uses validators library
  checks.push({
    name: 'validators',
    label: 'Uses validators.cjs for input validation',
    passed: scriptContent !== null && scriptContent.includes('validators.cjs'),
  });

  // 9. Has TypeScript type definitions
  const hasTs =
    fs.existsSync(scriptsDir) && fs.readdirSync(scriptsDir).some((f) => f.endsWith('.ts'));
  checks.push({
    name: 'typescript',
    label: 'Has TypeScript type definitions',
    passed: hasTs,
  });

  // 10. Has unit test coverage
  let hasUnitTest = false;
  if (fs.existsSync(unitTestPath)) {
    const testContent = fs.readFileSync(unitTestPath, 'utf8');
    hasUnitTest = testContent.includes(skillName);
  }
  checks.push({
    name: 'unit-tests',
    label: 'Has unit test coverage',
    passed: hasUnitTest,
  });

  // 11. Has integration test coverage
  let hasIntegrationTest = false;
  if (fs.existsSync(integrationTestPath)) {
    const testContent = fs.readFileSync(integrationTestPath, 'utf8');
    hasIntegrationTest = testContent.includes(skillName);
  }
  checks.push({
    name: 'integration-tests',
    label: 'Has integration test coverage',
    passed: hasIntegrationTest,
  });

  // 12. Error handling pattern (try-catch or runSkill envelope)
  checks.push({
    name: 'error-handling',
    label: 'Has proper error handling',
    passed:
      scriptContent !== null &&
      (scriptContent.includes('runSkill') ||
        scriptContent.includes('try {') ||
        scriptContent.includes('catch (')),
  });

  const passedCount = checks.filter((c) => c.passed).length;
  const totalCount = checks.length;
  const score = passedCount;
  const percentage = Math.round((passedCount / totalCount) * 100);

  let grade;
  if (percentage >= 90) grade = 'A';
  else if (percentage >= 75) grade = 'B';
  else if (percentage >= 60) grade = 'C';
  else if (percentage >= 40) grade = 'D';
  else grade = 'F';

  const recommendations = checks
    .filter((c) => !c.passed)
    .map((c) => `Add ${c.label.toLowerCase()}`);

  return {
    skill: skillName,
    score,
    maxScore: totalCount,
    percentage,
    grade,
    checks,
    recommendations,
  };
}

runSkill('skill-quality-auditor', () => {
  const skillNames = argv.skill ? [argv.skill] : getSkillDirs();
  const results = skillNames.map(auditSkill);

  // Sort by score ascending (worst first)
  results.sort((a, b) => a.score - b.score);

  const totalSkills = results.length;
  const avgScore =
    totalSkills > 0
      ? Math.round((results.reduce((s, r) => s + r.score, 0) / totalSkills) * 10) / 10
      : 0;
  const avgPercentage =
    totalSkills > 0 ? Math.round(results.reduce((s, r) => s + r.percentage, 0) / totalSkills) : 0;
  const gradeA = results.filter((r) => r.grade === 'A').length;
  const gradeB = results.filter((r) => r.grade === 'B').length;
  const failing = results.filter((r) => r.score < argv['min-score']).length;

  return {
    summary: {
      totalSkills,
      avgScore: `${avgScore}/12`,
      avgPercentage: `${avgPercentage}%`,
      gradeDistribution: {
        A: gradeA,
        B: gradeB,
        C: results.filter((r) => r.grade === 'C').length,
        D: results.filter((r) => r.grade === 'D').length,
        F: results.filter((r) => r.grade === 'F').length,
      },
      failingThreshold: failing > 0 ? `${failing} skills below ${argv['min-score']}/12` : 'none',
    },
    skills: results,
  };
});
