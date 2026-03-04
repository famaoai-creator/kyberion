/**
 * scripts/run_all_tests.ts
 * Global Unit Test Runner
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';

const rootDir = process.cwd();

const dirs = fs.readdirSync(rootDir).filter((f) => {
  try {
    return (
      fs.statSync(path.join(rootDir, f)).isDirectory() &&
      !f.startsWith('.') &&
      f !== 'node_modules' &&
      f !== 'scripts' &&
      f !== 'knowledge' &&
      f !== 'dist'
    );
  } catch (_e) {
    return false;
  }
});

let total = 0;
let passed = 0;
let failed = 0;

console.log(chalk.bold.cyan('\n--- Gemini Skills: Global Unit Test Runner (TS) ---\n'));

for (const dir of dirs) {
  const testDir = path.join(rootDir, dir, 'tests');
  if (fs.existsSync(testDir)) {
    const tests = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.cjs') || f.endsWith('.test.js') || f.endsWith('.test.ts'));
    
    for (const test of tests) {
      total++;
      const testPath = path.join(testDir, test);
      process.stdout.write(`[TEST] Running: ${dir}/${test}... `);
      try {
        execSync(`node "${testPath}"`, { stdio: 'ignore', cwd: rootDir });
        console.log(chalk.green('PASSED'));
        passed++;
      } catch (_e) {
        console.log(chalk.red('FAILED'));
        failed++;
      }
    }
  }
}

console.log('\n' + chalk.dim('━'.repeat(50)));
console.log(`Results: ${passed} passed, ${failed} failed of ${total}`);
console.log(chalk.dim('━'.repeat(50)) + '\n');

if (failed > 0) process.exit(1);
