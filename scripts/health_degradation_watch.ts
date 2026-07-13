/**
 * health_degradation_watch.ts — OP-04 Task 1 CLI entry.
 *
 * Runs the degradation watch (latency regressions + provider demotions vs
 * knowledge/product/governance/health-thresholds.json, plus the CO-03
 * finance controller's budget/KPI signal) and prints the report. Non-green
 * verdicts have already been escalated through the AO-03 ops-alert sink by
 * the time this exits; the exit code stays 0 so the hourly schedule never
 * spams pipeline failures on top of the alert.
 *
 * Scheduled via pipelines/health-degradation-watch.json (hourly).
 */

import { logger, resolveFinanceControllerDecision, runDegradationWatch } from '@agent/core';

function main(): number {
  const { report, alert } = runDegradationWatch({
    financeDecision: resolveFinanceControllerDecision(),
  });
  console.log(JSON.stringify({ ...report, alert_id: alert?.id ?? null }, null, 2));
  if (report.verdict === 'green') {
    logger.info('[health-degradation] green — no findings');
  }
  return 0;
}

const isDirect = process.argv[1] && /health_degradation_watch\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  process.exit(main());
}
