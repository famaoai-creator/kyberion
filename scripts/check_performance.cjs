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
    .option('fail-on-regression', {
      type: 'boolean',
      default: false,
      describe: 'Exit with code 1 if regressions detected',
    })
    .option('out', { type: 'string', describe: 'Path to save ADF report (JSON)' }).argv;
  console.log(chalk.bold('\n--- Gemini Ecosystem Performance Health Check ---\n'));
  const history = metrics.reportFromHistory();
  logger.info(
    `Analyzing ${history.totalEntries} execution records across ${history.uniqueSkills} skills...`
  );
  let regressionFound = false;
  const adfReport = {
    timestamp: new Date().toISOString(),
    summary: {
      total_records: history.totalEntries,
      unique_skills: history.uniqueSkills,
    },
    regressions: [],
    slow_skills: [],
    unstable_skills: [],
    efficiency_alerts: [],
    slo_breaches: [],
  };

  // 2. Load SLO Targets
  const sloPath = path.resolve(__dirname, '../knowledge/orchestration/slo-targets.json');
  const sloTargets = fs.existsSync(sloPath)
    ? JSON.parse(fs.readFileSync(sloPath, 'utf8'))
    : { default: { latency_ms: 5000, success_rate: 99 } };

  // 1. Detect Regressions
  const regressions = metrics.detectRegressions(2.0);
  if (regressions.length > 0) {
    regressionFound = true;
    console.log(chalk.yellow('\n[!] Potential Performance Regressions Detected:'));
    regressions.forEach((r) => {
      console.log(
        `  - ${chalk.bold(r.skill.padEnd(25))} ${r.lastDuration}ms (vs avg ${r.historicalAvg}ms, ${r.increaseRate}x slower)`
      );
      adfReport.regressions.push(r);
    });
  } else {
    logger.success('No significant performance regressions detected in recent runs.');
  }
  // 2. Identify Resource Hogs (Time)
  const slowSkills = history.skills.filter((s) => s.avgMs > 100).slice(0, 5);
  if (slowSkills.length > 0) {
    console.log(chalk.cyan('\n[i] Top 5 Slowest Skills (Avg Execution Time):'));
    slowSkills.forEach((s) => {
      console.log(
        `  - ${s.skill.padEnd(25)} avg: ${s.avgMs}ms  max: ${s.maxMs}ms  (Score: ${s.efficiencyScore})`
      );
      adfReport.slow_skills.push(s);
    });
  }
  // 2.1 Low Efficiency Score Warning
  const inefficient = history.skills.filter((s) => s.efficiencyScore < 80).slice(0, 5);
  if (inefficient.length > 0) {
    console.log(chalk.magenta('\n[!] Skills with Low Efficiency Scores (< 80):'));
    inefficient.forEach((s) => {
      console.log(
        `  - ${s.skill.padEnd(25)} Score: ${s.efficiencyScore} (avg: ${s.avgMs}ms, peak: ${s.peakHeapMB}MB)`
      );
      adfReport.efficiency_alerts.push(s);
    });
  }
  // 2.2 SRE: SLO Breach Detection
  history.skills.forEach((s) => {
    const target =
      (sloTargets.critical_path && sloTargets.critical_path[s.skill]) || sloTargets.default;
    const isLatencyOk = s.avgMs <= target.latency_ms;
    const isErrorOk = 100 - s.errorRate >= target.success_rate;

    if (!isLatencyOk || !isErrorOk) {
      adfReport.slo_breaches.push({
        skill: s.skill,
        actual_latency: s.avgMs,
        target_latency: target.latency_ms,
        actual_success: (100 - s.errorRate).toFixed(1),
        target_success: target.success_rate,
      });
    }
  });

  if (adfReport.slo_breaches.length > 0) {
    console.log(chalk.red('\n[!] SRE Service Level Objective (SLO) Breaches:'));
    adfReport.slo_breaches.slice(0, 5).forEach((b) => {
      console.log(
        `  - ${chalk.bold(b.skill.padEnd(25))} Latency: ${b.actual_latency}ms (target ${b.target_latency}ms), Success: ${b.actual_success}% (target ${b.target_success}%)`
      );
    });
  }
  // 4. Save ADF Report & Trend Analysis
  const defaultOutDir = path.resolve(__dirname, '../evidence/performance');
  if (!fs.existsSync(defaultOutDir)) fs.mkdirSync(defaultOutDir, { recursive: true });

  // Find previous reports for trend and chronic breach analysis
  const prevReports = fs
    .readdirSync(defaultOutDir)
    .filter((f) => f.startsWith('perf-report-'))
    .sort()
    .reverse(); // Newest first

  const trendData = {};
  const chronicBreaches = {}; // skill -> count

  if (prevReports.length > 0) {
    // 1. Load latest report for trend
    try {
      const latestReport = JSON.parse(
        fs.readFileSync(path.join(defaultOutDir, prevReports[0]), 'utf8')
      );
      latestReport.efficiency_alerts.forEach((s) => {
        trendData[s.skill] = s.efficiencyScore;
      });
    } catch (_) {}

    // 2. Analyze history for chronic SLO breaches
    for (const reportFile of prevReports.slice(0, 5)) {
      // Check last 5 reports
      try {
        const report = JSON.parse(fs.readFileSync(path.join(defaultOutDir, reportFile), 'utf8'));
        if (report.slo_breaches) {
          report.slo_breaches.forEach((b) => {
            chronicBreaches[b.skill] = (chronicBreaches[b.skill] || 0) + 1;
          });
        }
      } catch (_) {}
    }
  }

  const outPath =
    argv.out ||
    path.join(defaultOutDir, `perf-report-${new Date().toISOString().split('T')[0]}.json`);

  // Add severity and chronic info to current breaches
  adfReport.slo_breaches.forEach((b) => {
    const count = chronicBreaches[b.skill] || 0;
    b.consecutive_breaches = count + 1;
    b.severity =
      b.consecutive_breaches >= 3 ? 'CRITICAL' : b.consecutive_breaches >= 2 ? 'WARN' : 'INFO';

    // SRE: Auto-Quarantine for CRITICAL breaches
    if (b.severity === 'CRITICAL') {
      const skillMdPath = path.resolve(rootDir, b.skill, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        let md = fs.readFileSync(skillMdPath, 'utf8');
        if (!md.includes('status: unstable')) {
          md = md.replace(/status: .*/, 'status: unstable');
          fs.writeFileSync(skillMdPath, md);
          console.log(
            chalk.red(
              `  [QUARANTINE] ${b.skill} has been marked as 'unstable' due to chronic SLO breaches.`
            )
          );
        }
      }
    }
  });

  // Add trend information to current report
  adfReport.efficiency_alerts.forEach((s) => {
    const prevScore = trendData[s.skill];
    if (prevScore !== undefined) {
      s.trend =
        s.efficiencyScore > prevScore
          ? 'improving'
          : s.efficiencyScore < prevScore
            ? 'degrading'
            : 'stable';
      s.prevScore = prevScore;
    }
  });

  const { safeWriteFile } = require('./lib/secure-io.cjs');
  safeWriteFile(outPath, JSON.stringify(adfReport, null, 2));
  console.log(chalk.dim(`\nADF Report with Trends saved to: ${outPath}`));

  console.log(chalk.bold('\n--- Check Complete ---\n'));
  if (argv['fail-on-regression'] && regressionFound) {
    logger.error('Performance health check failed due to regressions.');
    process.exit(1);
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
