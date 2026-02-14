#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
// core.cjs available if needed

/**
 * Skill Quality Audit - checks every implemented skill against a quality checklist.
 *
 * Usage:
 *   node scripts/audit_skills.cjs              # Table output
 *   node scripts/audit_skills.cjs --format json # JSON output for CI
 */

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
const unitTestPath = path.join(rootDir, 'tests/unit.test.cjs');
const formatJson = process.argv.includes('--format') && process.argv.includes('json');

function loadIndex() {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function checkSkill(skillName) {
  const skillDir = path.join(rootDir, skillName);
  const checks = {};

  // 1. Has package.json?
  checks.packageJson = fs.existsSync(path.join(skillDir, 'package.json'));

  // 2. Uses runSkill()?
  checks.skillWrapper = false;
  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const scripts = fs.readdirSync(scriptsDir).filter((f) => /\.(cjs|js|mjs)$/.test(f));
    for (const script of scripts) {
      const content = fs.readFileSync(path.join(scriptsDir, script), 'utf8');
      if (
        content.includes('runSkill') ||
        content.includes('runSkillAsync') ||
        content.includes('runAsyncSkill')
      ) {
        checks.skillWrapper = true;
        break;
      }
    }
  }

  // 3. Uses yargs?
  checks.yargs = false;
  if (fs.existsSync(scriptsDir)) {
    const scripts = fs.readdirSync(scriptsDir).filter((f) => /\.(cjs|js|mjs)$/.test(f));
    for (const script of scripts) {
      const content = fs.readFileSync(path.join(scriptsDir, script), 'utf8');
      if (content.includes('yargs')) {
        checks.yargs = true;
        break;
      }
    }
  }

  // 4. SKILL.md quality
  const skillMd = path.join(skillDir, 'SKILL.md');
  checks.skillMd = false;
  if (fs.existsSync(skillMd)) {
    const content = fs.readFileSync(skillMd, 'utf8');
    const hasName = /name:\s*.+$/m.test(content);
    const hasDesc = /description:\s*.+$/m.test(content);
    const hasStatus = /status:\s*(implemented|planned|conceptual)$/m.test(content);
    checks.skillMd = hasName && hasDesc && hasStatus;
  }

  // 5. Has unit tests?
  checks.unitTests = false;
  const testFiles = [
    path.join(rootDir, 'tests/unit.test.cjs'),
    path.join(rootDir, 'tests/smoke.test.cjs'),
    path.join(skillDir, 'tests/unit.test.cjs'),
  ];
  for (const tPath of testFiles) {
    if (fs.existsSync(tPath)) {
      const testContent = fs.readFileSync(tPath, 'utf8');
      if (testContent.includes(skillName)) {
        checks.unitTests = true;
        break;
      }
    }
  }

  // Calculate score (0-5)
  checks.score = Object.values(checks).filter((v) => v === true).length;
  checks.maxScore = 5;

  return checks;
}

// Main
const index = loadIndex();
const implemented = index.skills.filter((s) => s.status === 'implemented');
const results = [];

for (const skill of implemented) {
  const checks = checkSkill(skill.name);
  results.push({ name: skill.name, ...checks });
}

// Sort by score ascending (worst first)
results.sort((a, b) => a.score - b.score);

if (formatJson) {
  const summary = {
    total: results.length,
    avgScore: Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 10) / 10,
    perfect: results.filter((r) => r.score === r.maxScore).length,
    needsWork: results.filter((r) => r.score < 3).length,
    skills: results,
  };
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\nSkill Quality Audit - ${results.length} implemented skills\n`);
  console.log('  ' + 'Skill'.padEnd(35) + 'pkg.json  wrapper  yargs  SKILL.md  tests  Score');
  console.log('  ' + '-'.repeat(85));

  for (const r of results) {
    const mark = (v) => (v ? '  Y  ' : '  -  ');
    console.log(
      '  ' +
        r.name.padEnd(35) +
        mark(r.packageJson) +
        '   ' +
        mark(r.skillWrapper) +
        '  ' +
        mark(r.yargs) +
        '  ' +
        mark(r.skillMd) +
        '  ' +
        mark(r.unitTests) +
        '  ' +
        `${r.score}/${r.maxScore}`
    );
  }

  const avg = Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 10) / 10;
  const perfect = results.filter((r) => r.score === r.maxScore).length;
  console.log('\n  ' + '-'.repeat(85));
  console.log(
    `  Average: ${avg}/5  |  Perfect (5/5): ${perfect}  |  Needs work (<3): ${results.filter((r) => r.score < 3).length}`
  );
}
