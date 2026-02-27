const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

if (!fs.existsSync(indexPath)) {
  console.error('Index not found. Run npm run generate-index first.');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const skills = index.s || index.skills;
const IMPLEMENTED_SKILLS = [];

for (const skill of skills) {
  if ((skill.s || skill.status) !== 'impl' && (skill.s || skill.status) !== 'implemented') continue;

  const skillName = skill.n || skill.name;
  const skillPath = skill.path || skillName;
  const skillFullDir = path.join(rootDir, skillPath);

  // Find script path (reuse logic from cli.cjs or simplified)
  const scriptsDir = path.join(skillFullDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const scripts = fs
      .readdirSync(scriptsDir)
      .filter((f) => f.endsWith('.cjs') || f.endsWith('.js'));
    if (scripts.length > 0) {
      IMPLEMENTED_SKILLS.push({ name: skillName, path: skillPath, script: scripts[0] });
    }
  }
}

let passed = 0;
let failed = 0;
const failures = [];

console.log(`\nSmoke tests for ${IMPLEMENTED_SKILLS.length} implemented skills...\n`);

for (const skill of IMPLEMENTED_SKILLS) {
  const scriptPath = path.join(rootDir, skill.path, 'scripts', skill.script);
  try {
    execSync(`node --check "${scriptPath}"`, { timeout: 5000, stdio: 'pipe' });
    console.log(`  pass  ${skill.name}/${skill.script}`);
    passed++;
  } catch (_err) {
    console.error(`  FAIL  ${skill.name}/${skill.script}: ${_err.message.split('\n')[0]}`);
    failures.push(skill.name);
    failed++;
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed of ${IMPLEMENTED_SKILLS.length}`);

if (failures.length > 0) {
  console.log(`\nFailed: ${failures.join(', ')}`);
}

const failureRate = IMPLEMENTED_SKILLS.length > 0 ? failed / IMPLEMENTED_SKILLS.length : 0;
if (failureRate > 0.05) {
  console.error(`\nFailure rate ${(failureRate * 100).toFixed(1)}% exceeds 5% threshold`);
  process.exit(1);
}
