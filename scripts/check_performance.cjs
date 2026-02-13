#!/usr/bin/env node
const { metrics } = require('./lib/metrics.cjs');
const { logger } = require('./lib/core.cjs');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');

/**
 * Performance Health Check Tool
 * Analyzes historical metrics to find regressions and resource hogs.
 */

async function main() {

  const argv = require('yargs/yargs')(process.argv.slice(2))

    .option('fail-on-regression', { type: 'boolean', default: false, describe: 'Exit with code 1 if regressions detected' })

    .option('out', { type: 'string', describe: 'Path to save ADF report (JSON)' })

    .argv;



  console.log(chalk.bold('\n--- Gemini Ecosystem Performance Health Check ---\n'));



  const history = metrics.reportFromHistory();

  logger.info(`Analyzing ${history.totalEntries} execution records across ${history.uniqueSkills} skills...`);



  let regressionFound = false;

  const adfReport = {

    timestamp: new Date().toISOString(),

    summary: {

      total_records: history.totalEntries,

      unique_skills: history.uniqueSkills

    },

    regressions: [],

    slow_skills: [],

    unstable_skills: [],

    efficiency_alerts: []

  };



  // 1. Detect Regressions

  const regressions = metrics.detectRegressions(2.0);

  if (regressions.length > 0) {

    regressionFound = true;

    console.log(chalk.yellow('\n[!] Potential Performance Regressions Detected:'));

    regressions.forEach(r => {

      console.log(`  - ${chalk.bold(r.skill.padEnd(25))} ${r.lastDuration}ms (vs avg ${r.historicalAvg}ms, ${r.increaseRate}x slower)`);

      adfReport.regressions.push(r);

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

      adfReport.slow_skills.push(s);

    });

  }



  // 2.1 Low Efficiency Score Warning

  const inefficient = history.skills.filter(s => s.efficiencyScore < 80).slice(0, 5);

  if (inefficient.length > 0) {

    console.log(chalk.magenta('\n[!] Skills with Low Efficiency Scores (< 80):'));

    inefficient.forEach(s => {

      console.log(`  - ${s.skill.padEnd(25)} Score: ${s.efficiencyScore} (avg: ${s.avgMs}ms, peak: ${s.peakHeapMB}MB)`);

      adfReport.efficiency_alerts.push(s);

    });

  }



  // 3. Reliability Check

  const unstable = history.skills.filter(s => s.errorRate > 5).slice(0, 5);

  if (unstable.length > 0) {

    console.log(chalk.red('\n[!] Skills with High Error Rates (> 5%):'));

    unstable.forEach(s => {

      console.log(`  - ${s.skill.padEnd(25)} error rate: ${s.errorRate}%  (${s.errors}/${s.executions})`);

      adfReport.unstable_skills.push(s);

    });

  }



  // 4. Save ADF Report

  const defaultOutDir = path.resolve(__dirname, '../evidence/performance');

  if (!fs.existsSync(defaultOutDir)) fs.mkdirSync(defaultOutDir, { recursive: true });

  

  const outPath = argv.out || path.join(defaultOutDir, `perf-report-${new Date().toISOString().split('T')[0]}.json`);

  const { safeWriteFile } = require('./lib/secure-io.cjs');

  safeWriteFile(outPath, JSON.stringify(adfReport, null, 2));

  console.log(chalk.dim(`\nADF Report saved to: ${outPath}`));



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
