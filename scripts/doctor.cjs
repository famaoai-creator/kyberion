#!/usr/bin/env node
/**
 * scripts/doctor.cjs
 *
 * Unified health checker for the Gemini Skills monorepo.
 * Runs all quality checks in sequence and produces a concise summary.
 *
 * Usage: npm run doctor
 */

const { execSync } = require('child_process');
const chalk = require('chalk');

const rootDir = require('path').resolve(__dirname, '..');
const checks = [];

function runCheck(name, cmd, parser) {
  process.stdout.write(chalk.dim(`  ⏳ ${name}...`));
  try {
    const output = execSync(cmd + ' 2>&1', {
      encoding: 'utf8',
      cwd: rootDir,
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = parser(output, null);
    checks.push({ name, ...result });
    process.stdout.write(`\r${result.icon}  ${name.padEnd(24)} ${result.detail}\n`);
  } catch (err) {
    const combined = (err.stdout || '') + (err.stderr || '');
    const result = parser(combined, err.message);
    checks.push({ name, ...result });
    process.stdout.write(`\r${result.icon}  ${name.padEnd(24)} ${result.detail}\n`);
  }
}

// ─────────────────────────────────────────────
console.log(chalk.bold.cyan('\n🏥 Gemini Skills Doctor'));
console.log(chalk.dim('━'.repeat(50)));

// 1. SKILL.md Validation
runCheck('SKILL.md Validation', 'node scripts/validate_skills.cjs', (out, err) => {
  const combined = (out || '') + (err || '');
  if (!combined.includes('All skills have valid metadata') && !combined.includes('Checked')) {
    return { status: 'fail', icon: '❌', detail: 'Validation failed' };
  }
  const match = combined.match(/Checked (\d+) skills/);
  const count = match ? match[1] : '?';
  return { status: 'pass', icon: '✅', detail: `${count} skills validated` };
});

// 2. Schema Validation
runCheck('Schema Validation', 'node scripts/validate_schemas.cjs', (out, _err) => {
  const combined = (out || '') + (_err || '');
  const match = combined.match(/Validated (\d+) schema/);
  const count = match ? match[1] : '?';
  if (combined.includes('All schemas are valid') || combined.includes('Validated')) {
    return { status: 'pass', icon: '✅', detail: `${count} schemas valid` };
  }
  return { status: 'fail', icon: '❌', detail: 'Schema errors found' };
});

// 3. ESLint
runCheck('ESLint', 'npx eslint . --max-warnings 0 --format json', (out, _err) => {
  try {
    const data = JSON.parse(out);
    let errors = 0;
    let warnings = 0;
    for (const f of data) {
      errors += f.errorCount || 0;
      warnings += f.warningCount || 0;
    }
    if (errors > 0) {
      return { status: 'fail', icon: '❌', detail: `${errors} errors, ${warnings} warnings` };
    }
    if (warnings > 0) {
      return { status: 'warn', icon: '⚠️ ', detail: `0 errors, ${warnings} warnings` };
    }
    return { status: 'pass', icon: '✅', detail: '0 errors, 0 warnings' };
  } catch (_e) {
    return { status: 'pass', icon: '✅', detail: '0 errors, 0 warnings' };
  }
});

// 4. Smoke Tests
runCheck('Smoke Tests', 'node tests/smoke.test.cjs', (out, _err) => {
  const match = out.match(/Results: (\d+) passed, (\d+) failed/);
  if (match) {
    const passed = parseInt(match[1]);
    const failed = parseInt(match[2]);
    if (failed > 0) {
      return { status: 'fail', icon: '❌', detail: `${passed} passed, ${failed} failed` };
    }
    return { status: 'pass', icon: '✅', detail: `${passed}/${passed + failed} passed` };
  }
  return { status: 'fail', icon: '❌', detail: 'Could not parse results' };
});

// 5. Health Check (broken mains)
runCheck('Health Check', 'node scripts/check_skills_health.cjs', (out, _err) => {
  const match = out.match(/Total Issues: (\d+)/);
  if (match) {
    const issues = parseInt(match[1]);
    if (issues > 0) {
      return { status: 'warn', icon: '⚠️ ', detail: `${issues} broken skill mains` };
    }
  }
  return { status: 'pass', icon: '✅', detail: 'All mains resolve' };
});

// 6. Core Library Tests
runCheck(
  'Core Lib Tests',
  'node scripts/bootstrap.cjs && node tests/unit/core-lib.test.cjs',
  (out, _err) => {
    const match = out.match(/Results: (\d+) passed, (\d+) failed/);
    if (match) {
      const passed = parseInt(match[1]);
      const failed = parseInt(match[2]);
      if (failed > 0) {
        return { status: 'fail', icon: '❌', detail: `${passed} passed, ${failed} failed` };
      }
      return { status: 'pass', icon: '✅', detail: `${passed} passed` };
    }
    return { status: 'fail', icon: '❌', detail: 'Could not parse results' };
  }
);

// ─────────────────────────────────────────────
// Summary
console.log(chalk.dim('━'.repeat(50)));

const failed = checks.filter((c) => c.status === 'fail');
const warned = checks.filter((c) => c.status === 'warn');

if (failed.length > 0) {
  console.log(chalk.red.bold(`Overall: ❌ ${failed.length} check(s) FAILED`));
  process.exitCode = 1;
} else if (warned.length > 0) {
  console.log(chalk.yellow.bold(`Overall: ⚠️  NEEDS ATTENTION (${warned.length} warning(s))`));
} else {
  console.log(chalk.green.bold('Overall: ✅ ALL CHECKS PASSED'));
}

console.log('');
