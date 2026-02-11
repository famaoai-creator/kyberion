const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules', 'knowledge', 'scripts', 'schemas', 'templates',
  'evidence', 'coverage', 'test-results', 'work', 'nonfunctional', 'dist', 'tests', '.github'
]);

const IMPLEMENTED_SKILLS = [];

const dirs = fs.readdirSync(rootDir).filter(f => {
  const fullPath = path.join(rootDir, f);
  return fs.statSync(fullPath).isDirectory() && !f.startsWith('.') && !SKIP_DIRS.has(f);
});

for (const dir of dirs) {
  const skillPath = path.join(rootDir, dir, 'SKILL.md');
  const scriptsDir = path.join(rootDir, dir, 'scripts');
  if (fs.existsSync(skillPath) && fs.existsSync(scriptsDir)) {
    const scripts = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.cjs') || f.endsWith('.js') || f.endsWith('.mjs'));
    if (scripts.length > 0) {
      IMPLEMENTED_SKILLS.push({ name: dir, script: scripts[0] });
    }
  }
}

let passed = 0;
let failed = 0;
const failures = [];

console.log(`\nSmoke tests for ${IMPLEMENTED_SKILLS.length} implemented skills...\n`);

for (const skill of IMPLEMENTED_SKILLS) {
  const scriptPath = path.join(rootDir, skill.name, 'scripts', skill.script);
  try {
    execSync(`node --check "${scriptPath}"`, { timeout: 5000, stdio: 'pipe' });
    console.log(`  pass  ${skill.name}/${skill.script}`);
    passed++;
  } catch (_err) {
    console.error(`  FAIL  ${skill.name}/${skill.script}: ${err.message.split('\n')[0]}`);
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
if (failureRate > 0.2) {
  console.error(`\nFailure rate ${(failureRate * 100).toFixed(1)}% exceeds 20% threshold`);
  process.exit(1);
}
