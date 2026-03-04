/**
 * scripts/doctor.ts
 * Unified health checker for the Gemini Skills monorepo.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';

const rootDir = process.cwd();
const checks: any[] = [];
const isJsonMode = process.argv.includes('--json');

function runCheck(name: string, cmd: string, parser: (out: string, err: string | null) => any) {
  if (!isJsonMode) process.stdout.write(chalk.dim(`  ⏳ ${name}...\r`));
  try {
    const output = execSync(cmd + ' 2>&1', {
      encoding: 'utf8',
      cwd: rootDir,
      timeout: 60000,
    });
    const result = parser(output, null);
    checks.push({ name, ...result });
    if (!isJsonMode) process.stdout.write(`${result.icon}  ${name.padEnd(24)} ${result.detail}\n`);
  } catch (err: any) {
    const combined = (err.stdout || '') + (err.stderr || '');
    const result = parser(combined, err.message);
    checks.push({ name, ...result });
    if (!isJsonMode) process.stdout.write(`${result.icon}  ${name.padEnd(24)} ${result.detail}\n`);
  }
}

async function main() {
  if (!isJsonMode) {
    console.log(chalk.bold.cyan('\n🏥 Gemini Skills Doctor (TS)'));
    console.log(chalk.dim('━'.repeat(50)));
  }

  runCheck('SKILL.md Validation', 'node dist/scripts/validate_skills.js', (out) => {
    const match = out.match(/Checked (\d+) skills/);
    return { status: out.toLowerCase().includes('success') ? 'pass' : 'fail', icon: out.toLowerCase().includes('success') ? '✅' : '❌', detail: `${match ? match[1] : '?'} skills validated` };
  });

  runCheck('Health Check', 'node dist/scripts/check_skills_health.js', (out) => {
    const match = out.match(/Total Issues: (\d+)/);
    const issues = match ? parseInt(match[1]) : 0;
    return { status: issues === 0 ? 'pass' : 'warn', icon: issues === 0 ? '✅' : '⚠️', detail: issues === 0 ? 'All mains resolve' : `${issues} issues found` };
  });

  const failed = checks.filter(c => c.status === 'fail');
  const overall = failed.length > 0 ? 'FAILED' : 'PASSED';

  if (!isJsonMode) {
    console.log(chalk.dim('━'.repeat(50)));
    if (failed.length > 0) console.log(chalk.red.bold(`Overall: ❌ ${failed.length} check(s) FAILED`));
    else console.log(chalk.green.bold('Overall: ✅ ALL CHECKS PASSED'));
  } else {
    const reportPath = path.join(rootDir, 'presence/displays/chronos-mirror/public/doctor_report.json');
    const report = {
      timestamp: new Date().toISOString(),
      overall,
      checks
    };
    if (!fs.existsSync(path.dirname(reportPath))) fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[Doctor] JSON report saved to ${reportPath}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
