#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const dirs = fs.readdirSync(rootDir).filter((f) => {
  try {
    return (
      fs.statSync(path.join(rootDir, f)).isDirectory() &&
      !f.startsWith('.') &&
      f !== 'node_modules' &&
      f !== 'scripts' &&
      f !== 'knowledge'
    );
  } catch (e) {
    return false;
  }
});

let total = 0;
let passed = 0;
let failed = 0;

console.log('\n--- Gemini Skills: Global Unit Test Runner ---\n');

for (const dir of dirs) {
  const testDir = path.join(rootDir, dir, 'tests');
  if (fs.existsSync(testDir)) {
    const tests = fs
      .readdirSync(testDir)
      .filter((f) => f.endsWith('.test.cjs') || f.endsWith('.test.js'));
    for (const test of tests) {
      total++;
      const testPath = path.join(testDir, test);
      console.log(`[TEST] Running: ${dir}/${test}...`);
      try {
        execSync(`node "${testPath}"`, { stdio: 'inherit', cwd: rootDir });
        passed++;
      } catch (e) {
        console.error(`[ERROR] Failed: ${dir}/${test}`);
        failed++;
      }
    }
  }
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed of ${total}`);
console.log('='.repeat(50) + '\n');

if (failed > 0) process.exit(1);
