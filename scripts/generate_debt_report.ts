/**
 * scripts/generate_debt_report.ts
 * Strategic Debt Advisor
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function generateReport() {
  const perfDir = path.join(rootDir, 'evidence/performance');
  if (!fs.existsSync(perfDir)) return;

  const files = fs.readdirSync(perfDir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return;

  const latest = JSON.parse(safeReadFile(path.join(perfDir, files[files.length - 1]), { encoding: 'utf8' }) as string);
  const breaches = latest.slo_breaches || [];

  console.log(chalk.bold.yellow('\n--- 📉 Strategic Debt & Risk Report ---\n'));

  if (breaches.length === 0) {
    console.log(chalk.green('  ✅ No technical debt detected. All systems are operating within SLO targets.'));
    return;
  }

  const estimatedHourlyLoss = breaches.length * 50;

  console.log(`  Target Violation Count: ${chalk.red(breaches.length)} skills`);
  console.log(`  Estimated Efficiency Loss: ${chalk.red('$' + estimatedHourlyLoss + '/hr')}\n`);

  console.log(chalk.bold('Top Risks:'));
  breaches.slice(0, 10).forEach((b: any) => {
    const isLatencyBreach = b.actual_latency > b.target_latency;
    const isSuccessBreach = parseFloat(b.actual_success) < b.target_success;

    let detail = '';
    if (isLatencyBreach) {
      detail = `Latency Gap: +${b.actual_latency - b.target_latency}ms`;
    } else if (isSuccessBreach) {
      detail = `Success Rate: ${b.actual_success}% (Target ${b.target_success}%)`;
    } else {
      detail = `Consecutive: ${b.consecutive_breaches}`;
    }

    const risk = b.severity === 'CRITICAL' ? chalk.bgRed.white(' CRITICAL ') : chalk.yellow('Medium');
    console.log(`  - ${chalk.bold(b.skill.padEnd(25))} | Risk: ${risk.padEnd(15)} | ${detail}`);
  });

  console.log(chalk.dim('\nRecommendation: Reinvest saved hours into refactoring the chronic breaches above.\n'));
}

generateReport();
