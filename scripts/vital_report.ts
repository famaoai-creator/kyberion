import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { metrics, logger, pathResolver } from '@agent/core';

/**
 * scripts/vital_report.ts
 * Generates an Ecosystem Vitality Report based on physical evidence.
 */

async function main() {
  const metricsFile = path.join(process.cwd(), 'work', 'metrics/skill-metrics.jsonl');
  
  if (!fs.existsSync(metricsFile)) {
    logger.error('No metrics data found. Execute some skills first.');
    process.exit(1);
  }

  const lines = fs.readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => JSON.parse(l));

  let totalCost = 0;
  let totalExecutions = 0;
  let totalErrors = 0;
  let totalInterventions = 0;
  const skillStats: Record<string, any> = {};

  entries.forEach(e => {
    if (e.type === 'intervention') {
      totalInterventions++;
      return;
    }

    totalExecutions++;
    if (e.status === 'error') totalErrors++;
    
    // Sum cost if available
    if (e.cost_usd) totalCost += e.cost_usd;

    const s = e.skill;
    if (!skillStats[s]) {
      skillStats[s] = { count: 0, errors: 0, cost: 0, totalMs: 0 };
    }
    skillStats[s].count++;
    if (e.status === 'error') skillStats[s].errors++;
    if (e.cost_usd) skillStats[s].cost += e.cost_usd;
    skillStats[s].totalMs += e.duration_ms || 0;
  });

  const autonomyScore = totalExecutions > 0 
    ? Math.round((1 - (totalInterventions / totalExecutions)) * 100) 
    : 100;

  console.log(chalk.bold.cyan('\n=== ECOSYSTEM VITALITY REPORT ==='));
  console.log(chalk.dim(`Period: ${entries[0]?.timestamp} to ${entries[entries.length-1]?.timestamp}`));
  
  console.log(`\n${chalk.bold('Overall Financials:')}`);
  console.log(`- Total API Cost:   ${chalk.green('$' + totalCost.toFixed(4))}`);
  console.log(`- Total Executions: ${totalExecutions}`);
  
  console.log(`\n${chalk.bold('Sovereign Autonomy:')}`);
  console.log(`- Interventions:    ${totalInterventions}`);
  console.log(`- Autonomy Score:   ${autonomyScore >= 90 ? chalk.green(autonomyScore + '%') : chalk.yellow(autonomyScore + '%')}`);
  
  console.log(`\n${chalk.bold('Skill Performance (Top 5 by Execution):')}`);
  const sortedSkills = Object.entries(skillStats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  console.log(chalk.dim('Skill                | Execs | Errors | Avg Ms | Cost ($)'));
  console.log(chalk.dim('---------------------------------------------------------'));
  sortedSkills.forEach(([name, s]) => {
    const avgMs = Math.round(s.totalMs / s.count);
    const line = `${name.padEnd(20)} | ${String(s.count).padStart(5)} | ${String(s.errors).padStart(6)} | ${String(avgMs).padStart(6)} | ${s.cost.toFixed(4)}`;
    console.log(s.errors > 0 ? chalk.red(line) : line);
  });

  console.log(chalk.cyan('\n=================================\n'));
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
