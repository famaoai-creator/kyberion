#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

/**
 * Skill Quality Audit v2.0 - Hierarchical & Governance Aware
 */

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
const formatJson = process.argv.includes('--format') && process.argv.includes('json');

function loadIndex() {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function checkSkill(skillName, skillRelPath) {
  const skillDir = path.join(rootDir, skillRelPath);
  const checks = {
    packageJson: false,
    skillWrapper: false,
    secureIo: false, // NEW: Checks if it uses secure-io for governance
    governanceTags: false, // NEW: Namespace-specific keywords
    skillMd: false,
    unitTests: false,
  };

  // 1. Has package.json?
  checks.packageJson = fs.existsSync(path.join(skillDir, 'package.json'));

  // 2. Code Analysis (Wrapper & Secure-IO)
  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const scripts = fs.readdirSync(scriptsDir).filter((f) => /\.(cjs|js|mjs)$/.test(f));
    for (const script of scripts) {
      const content = fs.readFileSync(path.join(scriptsDir, script), 'utf8');
      if (content.includes('runSkill') || content.includes('runSkillAsync'))
        checks.skillWrapper = true;
      if (content.includes('secure-io') || content.includes('safeWriteFile'))
        checks.secureIo = true;
    }
  }

  // 3. SKILL.md quality & Governance alignment
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    const content = fs.readFileSync(skillMd, 'utf8');
    const hasName = /name:\s*.+$/m.test(content);
    const hasDesc = /description:\s*.+$/m.test(content);
    checks.skillMd = hasName && hasDesc;

    // Check for IPA/FISC if in audit or business category
    if (skillRelPath.includes('/audit/') || skillRelPath.includes('/business/')) {
      if (
        content.toUpperCase().includes('IPA') ||
        content.toUpperCase().includes('FISC') ||
        content.includes('governance')
      ) {
        checks.governanceTags = true;
      }
    } else {
      checks.governanceTags = true; // Not required for others
    }
  }

  // 4. Unit Tests presence
  const testFiles = [
    path.join(rootDir, 'tests/unit.test.cjs'),
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

  // Calculate score (0-6)
  checks.score = Object.values(checks).filter((v) => v === true).length;
  checks.maxScore = 6;

  return checks;
}

// Main
const index = loadIndex();
const skills = index.s || index.skills;
const implemented = skills.filter(
  (s) => (s.s || s.status) === 'impl' || (s.s || s.status) === 'implemented'
);
const results = [];

for (const skill of implemented) {
  const name = skill.n || skill.name;
  const sPath = skill.path || name;
  const checks = checkSkill(name, sPath);
  results.push({ name, category: sPath.split('/')[1] || 'General', ...checks });
}

// Sort by score ascending
results.sort((a, b) => a.score - b.score);

if (formatJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(
    chalk.bold.cyan(`\nSkill Quality Audit v2.0 - ${results.length} implemented skills\n`)
  );
  console.log(
    '  ' + 'Skill'.padEnd(35) + 'NS'.padEnd(12) + 'Wrapper  SecureIO  SKILL.md  Tests  Score'
  );
  console.log('  ' + '─'.repeat(95));

  for (const r of results) {
    const mark = (v) => (v ? chalk.green('  Y  ') : chalk.red('  -  '));
    const scoreColor =
      r.score === r.maxScore ? chalk.green : r.score < 4 ? chalk.red : chalk.yellow;

    console.log(
      '  ' +
        r.name.padEnd(35) +
        r.category.padEnd(12) +
        mark(r.skillWrapper) +
        mark(r.secureIo) +
        mark(r.skillMd) +
        mark(r.unitTests) +
        '  ' +
        scoreColor(`${r.score}/${r.maxScore}`)
    );
  }

  const avg = Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 10) / 10;
  const perfect = results.filter((r) => r.score === r.maxScore).length;
  console.log('\n  ' + '─'.repeat(95));
  console.log(
    `  Average Score: ${avg}/6  |  Perfect (6/6): ${perfect}  |  Critical Focus (<4): ${results.filter((r) => r.score < 4).length}`
  );
}
