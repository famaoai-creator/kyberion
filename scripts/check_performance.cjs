#!/usr/bin/env node
const { metrics } = require('./lib/metrics.cjs');
const { logger } = require('./lib/core.cjs');
const chalk = require('chalk');

/**
 * Performance Health Check Tool
 * Analyzes historical metrics to find regressions and resource hogs.
 */

async function main() {
  const argv = require('yargs/yargs')(process.argv.slice(2))
    .option('fail-on-regression', { type: 'boolean', default: false, describe: 'Exit with code 1 if regressions detected' })
    .argv;

  console.log(chalk.bold('\n--- Gemini Ecosystem Performance Health Check ---\n'));

  const history = metrics.reportFromHistory();
  logger.info(`Analyzing ${history.totalEntries} execution records across ${history.uniqueSkills} skills...`);

  let regressionFound = false;

  // 1. Detect Regressions
  const regressions = metrics.detectRegressions(1.3); // Flag if > 30% slower than avg
  if (regressions.length > 0) {
    regressionFound = true;
    console.log(chalk.yellow('\n[!] Potential Performance Regressions Detected:'));
    regressions.forEach(r => {
      console.log(`  - ${chalk.bold(r.skill.padEnd(25))} ${r.lastDuration}ms (vs avg ${r.historicalAvg}ms, ${r.increaseRate}x slower)`);
    });
  } else {
    logger.success('No significant performance regressions detected in recent runs.');
  }

      // 2. Identify Resource Hogs (Time)
      const slowSkills = history.skills.filter(s => s.avgMs > 100).slice(0, 5);
      if (slowSkills.length > 0) {
        console.log(chalk.cyan('\n[i] Top 5 Slowest Skills (Avg Execution Time):'));
        slowSkills.forEach(s => {
          console.log(`  - ${s.skill.padEnd(25)} avg: ${s.avgMs}ms  max: ${s.maxMs}ms  (Score: ${s.efficiencyScore})`);
        });
      }
  
      // 2.1 Low Efficiency Score Warning
      const inefficient = history.skills.filter(s => s.efficiencyScore < 80).slice(0, 5);
      if (inefficient.length > 0) {
        console.log(chalk.magenta('\n[!] Skills with Low Efficiency Scores (< 80):'));
        inefficient.forEach(s => {
          console.log(`  - ${s.skill.padEnd(25)} Score: ${s.efficiencyScore} (avg: ${s.avgMs}ms, peak: ${s.peakHeapMB}MB)`);
        });
      }
    // 3. Reliability Check
  const unstable = history.skills.filter(s => s.errorRate > 5).slice(0, 5);
  if (unstable.length > 0) {
    console.log(chalk.red('\n[!] Skills with High Error Rates (> 5%):'));
    unstable.forEach(s => {
      console.log(`  - ${s.skill.padEnd(25)} error rate: ${s.errorRate}%  (${s.errors}/${s.executions})`);
    });
  }

  console.log(chalk.bold('\n--- Check Complete ---\n'));

  if (argv['fail-on-regression'] && regressionFound) {
    logger.error('Performance health check failed due to regressions.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
