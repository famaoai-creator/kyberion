import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { metrics } from '@agent/core/metrics';
import { logger } from '@agent/core/core';
import * as pathResolver from '@agent/core/path-resolver';
import { safeWriteFile } from '@agent/core';

interface SLOTarget {
  latency_ms: number;
  success_rate: number;
}

interface SLOTargets {
  default: SLOTarget;
  critical_path?: Record<string, SLOTarget>;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('fail-on-regression', {
      type: 'boolean',
      default: false,
      describe: 'Exit with code 1 if regressions detected',
    })
    .option('out', { type: 'string', describe: 'Path to save ADF report (JSON)' })
    .parseSync();

  console.log(chalk.bold('\n--- Gemini Ecosystem Performance Health Check ---\n'));

  const history = metrics.reportFromHistory();
  logger.info(
    `Analyzing ${history.totalEntries} execution records across ${history.uniqueSkills} skills...`
  );

  let regressionFound = false;
  const adfReport: any = {
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
  const sloPath = path.resolve(process.cwd(), 'knowledge/orchestration/slo-targets.json');
  const sloTargets: SLOTargets = fs.existsSync(sloPath)
    ? JSON.parse(fs.readFileSync(sloPath, 'utf8'))
    : { default: { latency_ms: 5000, success_rate: 99 } };

  // 1. Detect Regressions
  const regressions = metrics.detectRegressions(2.0);
  if (regressions.length > 0) {
    regressionFound = true;
    console.log(chalk.yellow('\n[!] Potential Performance Regressions Detected:'));
    regressions.forEach((r: any) => {
      console.log(
        `  - ${chalk.bold(r.skill.padEnd(25))} ${r.lastDuration}ms (vs avg ${r.historicalAvg}ms, ${r.increaseRate}x slower)`
      );
      adfReport.regressions.push(r);
    });
  } else {
    logger.success('No significant performance regressions detected in recent runs.');
  }

  // 2. Identify Resource Hogs (Time)
  const slowSkills = history.skills.filter((s: any) => s.avgMs > 100).slice(0, 5);
  if (slowSkills.length > 0) {
    console.log(chalk.cyan('\n[i] Top 5 Slowest Skills (Avg Execution Time):'));
    slowSkills.forEach((s: any) => {
      console.log(
        `  - ${s.skill.padEnd(25)} avg: ${s.avgMs}ms  max: ${s.maxMs}ms  (Score: ${s.efficiencyScore})`
      );
      adfReport.slow_skills.push(s);
    });
  }

  // 2.1 Low Efficiency Score Warning
  const inefficient = history.skills.filter((s: any) => s.efficiencyScore < 80).slice(0, 5);
  if (inefficient.length > 0) {
    console.log(chalk.magenta('\n[!] Skills with Low Efficiency Scores (< 80):'));
    inefficient.forEach((s: any) => {
      console.log(
        `  - ${s.skill.padEnd(25)} Score: ${s.efficiencyScore} (avg: ${s.avgMs}ms, peak: ${s.peakHeapMB}MB)`
      );
      adfReport.efficiency_alerts.push(s);
    });
  }

  // 2.2 SRE: SLO Breach Detection
  history.skills.forEach((s: any) => {
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
    adfReport.slo_breaches.slice(0, 5).forEach((b: any) => {
      console.log(
        `  - ${chalk.bold(b.skill.padEnd(25))} Latency: ${b.actual_latency}ms (target ${b.target_latency}ms), Success: ${b.actual_success}% (target ${b.target_success}%)`
      );
    });
  }

  // 4. Save ADF Report & Trend Analysis
  const defaultOutDir = path.resolve(process.cwd(), 'evidence/performance');
  if (!fs.existsSync(defaultOutDir)) {
    fs.mkdirSync(defaultOutDir, { recursive: true });
  }

  // Find previous reports
  const prevReports = fs
    .readdirSync(defaultOutDir)
    .filter((f) => f.startsWith('perf-report-'))
    .sort()
    .reverse();

  const trendData: Record<string, number> = {};
  const chronicBreaches: Record<string, number> = {};

  if (prevReports.length > 0) {
    try {
      const latestReport = JSON.parse(
        fs.readFileSync(path.join(defaultOutDir, prevReports[0]), 'utf8')
      );
      latestReport.efficiency_alerts.forEach((s: any) => {
        trendData[s.skill] = s.efficiencyScore;
      });
    } catch (_) {}

    for (const reportFile of prevReports.slice(0, 5)) {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(defaultOutDir, reportFile), 'utf8'));
        if (report.slo_breaches) {
          report.slo_breaches.forEach((b: any) => {
            chronicBreaches[b.skill] = (chronicBreaches[b.skill] || 0) + 1;
          });
        }
      } catch (_) {}
    }
  }

  const outPath =
    argv.out ||
    path.join(defaultOutDir, `perf-report-${new Date().toISOString().split('T')[0]}.json`);

  adfReport.slo_breaches.forEach((b: any) => {
    const count = chronicBreaches[b.skill] || 0;
    b.consecutive_breaches = count + 1;
    b.severity =
      b.consecutive_breaches >= 3 ? 'CRITICAL' : b.consecutive_breaches >= 2 ? 'WARN' : 'INFO';

    if (b.severity === 'CRITICAL') {
      const skillFullDir = pathResolver.skillDir(b.skill);
      const skillMdPath = path.join(skillFullDir, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        let md = fs.readFileSync(skillMdPath, 'utf8');
        if (!md.includes('status: unstable')) {
          md = md.replace(/status: .*/, 'status: unstable');
          safeWriteFile(skillMdPath, md);
          console.log(
            chalk.red(
              `  [QUARANTINE] ${b.skill} has been marked as 'unstable' due to chronic SLO breaches.`
            )
          );
        }
      }
    }
  });

  adfReport.efficiency_alerts.forEach((s: any) => {
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
