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

import { resolveFinanceControllerDecision } from '@agent/core/finance-controller';
import { runDegradationWatch } from '@agent/core/health-degradation';
import { defineScript, isDirectScript } from './lib/harness.js';

export function runHealthDegradationWatch(): ReturnType<typeof runDegradationWatch> {
  return runDegradationWatch({
    financeDecision: resolveFinanceControllerDecision(),
  });
}

function main() {
  const { report, alert } = runHealthDegradationWatch();
  return { ...report, alert_id: alert?.id ?? null };
}

if (
  isDirectScript(import.meta.url, 'health_degradation_watch.ts') ||
  isDirectScript(import.meta.url, 'health_degradation_watch.js')
) {
  void defineScript({
    name: 'health:degradation-watch',
    flags: [],
    run(context) {
      const result = main();
      context.print(result);
      return result;
    },
  })();
}
