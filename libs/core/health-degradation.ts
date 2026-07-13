/**
 * health-degradation.ts — OP-04 Task 1: the degradation-detection loop.
 *
 * Evaluates the signals that indicate "the system is slowly getting worse"
 * — skill latency regressions (MetricsCollector.detectRegressions, which
 * existed but was never called) and provider demotions — against the
 * governed thresholds in knowledge/product/governance/health-thresholds.json,
 * and escalates warning/critical findings through the AO-03 ops-alert sink.
 *
 * v1 covers latency regressions + provider demotions; RSS/heap trends and
 * agent restart frequency plug in here once their history surfaces exist
 * (documented extension points, see the plan).
 */

import { logger } from './core.js';
import { metrics } from './metrics.js';
import {
  evaluateRuntimeHealthTrends,
  loadRuntimeHealthSamples,
  type RuntimeHealthSample,
} from './runtime-health-history.js';
import { sendOpsAlert, type OpsAlertReceipt } from './ops-alert.js';
import { pathResolver } from './path-resolver.js';
import { discoverProviders } from './provider-discovery.js';
import { listDemotedProviders } from './provider-health-registry.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import type { FinanceControllerDecision } from './finance-controller.js';

export interface HealthThresholds {
  /** detectRegressions multiplier: last run vs historical average. */
  regression_multiplier: number;
  /** Number of latency regressions that escalates yellow → red. */
  red_regressions: number;
  /** Number of fully demoted providers that escalates yellow → red. */
  red_demoted_providers: number;
  /** OP-04: RSS growth ratio (last/first in window) that warns / escalates. */
  rss_growth_warning_ratio: number;
  rss_growth_red_ratio: number;
  /** OP-04: agent restarts within the window that warn / escalate. */
  restart_warning_count: number;
  restart_red_count: number;
  /** OP-04: trend evaluation window in milliseconds (default 24h). */
  trend_window_ms: number;
}

export interface DegradationFinding {
  kind:
    | 'latency_regression'
    | 'provider_demotion'
    | 'rss_growth'
    | 'restart_frequency'
    | 'budget_or_kpi_signal';
  severity: 'warning' | 'critical';
  detail: string;
}

export interface DegradationReport {
  generated_at: string;
  verdict: 'green' | 'yellow' | 'red';
  findings: DegradationFinding[];
}

export interface LatencyRegression {
  skill: string;
  lastDuration: number;
  historicalAvg: number;
  increaseRate: number;
}

const THRESHOLDS_PATH = pathResolver.knowledge('product/governance/health-thresholds.json');

const DEFAULT_THRESHOLDS: HealthThresholds = {
  regression_multiplier: 1.5,
  red_regressions: 3,
  red_demoted_providers: 2,
  rss_growth_warning_ratio: 1.5,
  rss_growth_red_ratio: 2.5,
  restart_warning_count: 3,
  restart_red_count: 10,
  trend_window_ms: 24 * 60 * 60 * 1000,
};

function positiveOr(value: unknown, fallback: number, min = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > min ? parsed : fallback;
}

export function loadHealthThresholds(): HealthThresholds {
  if (!safeExistsSync(THRESHOLDS_PATH)) return DEFAULT_THRESHOLDS;
  try {
    const parsed = JSON.parse(
      String(safeReadFile(THRESHOLDS_PATH, { encoding: 'utf8' }) || '{}')
    ) as Partial<HealthThresholds>;
    return {
      regression_multiplier:
        Number(parsed.regression_multiplier) > 1
          ? Number(parsed.regression_multiplier)
          : DEFAULT_THRESHOLDS.regression_multiplier,
      red_regressions:
        Number(parsed.red_regressions) > 0
          ? Number(parsed.red_regressions)
          : DEFAULT_THRESHOLDS.red_regressions,
      red_demoted_providers:
        Number(parsed.red_demoted_providers) > 0
          ? Number(parsed.red_demoted_providers)
          : DEFAULT_THRESHOLDS.red_demoted_providers,
      rss_growth_warning_ratio: positiveOr(
        parsed.rss_growth_warning_ratio,
        DEFAULT_THRESHOLDS.rss_growth_warning_ratio,
        1
      ),
      rss_growth_red_ratio: positiveOr(
        parsed.rss_growth_red_ratio,
        DEFAULT_THRESHOLDS.rss_growth_red_ratio,
        1
      ),
      restart_warning_count: positiveOr(
        parsed.restart_warning_count,
        DEFAULT_THRESHOLDS.restart_warning_count
      ),
      restart_red_count: positiveOr(parsed.restart_red_count, DEFAULT_THRESHOLDS.restart_red_count),
      trend_window_ms: positiveOr(parsed.trend_window_ms, DEFAULT_THRESHOLDS.trend_window_ms),
    };
  } catch {
    // A broken thresholds file must not silence degradation detection.
    return DEFAULT_THRESHOLDS;
  }
}

export function evaluateDegradation(input: {
  regressions: LatencyRegression[];
  demotedProviders: string[];
  /** OP-04: RSS/restart trend samples over the window (optional). */
  runtimeSamples?: RuntimeHealthSample[];
  /** CO-03: budget/KPI signal from the finance controller (optional). */
  financeDecision?: FinanceControllerDecision | null;
  thresholds?: HealthThresholds;
  now?: number;
}): DegradationReport {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const findings: DegradationFinding[] = [];

  for (const trend of evaluateRuntimeHealthTrends(input.runtimeSamples ?? [], thresholds)) {
    findings.push({
      kind: trend.kind,
      severity: trend.severity,
      detail: trend.detail,
    });
  }

  if (input.financeDecision && input.financeDecision.mode !== 'growth') {
    findings.push({
      kind: 'budget_or_kpi_signal',
      severity: input.financeDecision.mode === 'cost_cutting' ? 'critical' : 'warning',
      detail: input.financeDecision.reasons.join('; ') || `finance controller mode: monitor`,
    });
  }

  const regressionsCritical = input.regressions.length >= thresholds.red_regressions;
  for (const regression of input.regressions) {
    findings.push({
      kind: 'latency_regression',
      severity: regressionsCritical ? 'critical' : 'warning',
      detail:
        `${regression.skill}: last run ${regression.lastDuration}ms vs avg ` +
        `${regression.historicalAvg}ms (${regression.increaseRate}x)`,
    });
  }

  const demotionsCritical = input.demotedProviders.length >= thresholds.red_demoted_providers;
  for (const provider of input.demotedProviders) {
    findings.push({
      kind: 'provider_demotion',
      severity: demotionsCritical ? 'critical' : 'warning',
      detail: `provider '${provider}' has no healthy instances`,
    });
  }

  const verdict = findings.some((finding) => finding.severity === 'critical')
    ? 'red'
    : findings.length > 0
      ? 'yellow'
      : 'green';

  return {
    generated_at: new Date(input.now ?? Date.now()).toISOString(),
    verdict,
    findings,
  };
}

export interface DegradationWatchDeps {
  regressions?: LatencyRegression[];
  demotedProviders?: string[];
  runtimeSamples?: RuntimeHealthSample[];
  /** CO-03: budget/KPI signal from the finance controller (opt-in; not fetched by default). */
  financeDecision?: FinanceControllerDecision | null;
  thresholds?: HealthThresholds;
  alert?: typeof sendOpsAlert;
  now?: number;
}

/**
 * Gather → evaluate → escalate. Warning verdicts send a warning ops-alert,
 * red verdicts send a critical one; green stays silent (alert-fatigue rule
 * from the plan). Returns the report either way.
 */
export function runDegradationWatch(deps: DegradationWatchDeps = {}): {
  report: DegradationReport;
  alert: OpsAlertReceipt | null;
} {
  const thresholds = deps.thresholds ?? loadHealthThresholds();
  const regressions =
    deps.regressions ??
    (metrics.detectRegressions(thresholds.regression_multiplier) as LatencyRegression[]);
  const demotedProviders = deps.demotedProviders ?? listDemotedProviders(discoverProviders());
  const runtimeSamples =
    deps.runtimeSamples ?? loadRuntimeHealthSamples(thresholds.trend_window_ms, deps.now);
  const report = evaluateDegradation({
    regressions,
    runtimeSamples,
    demotedProviders,
    financeDecision: deps.financeDecision ?? null,
    thresholds,
    now: deps.now,
  });

  if (report.verdict === 'green') {
    return { report, alert: null };
  }

  const send = deps.alert ?? sendOpsAlert;
  const alert = send({
    severity: report.verdict === 'red' ? 'critical' : 'warning',
    title: `System degradation detected (${report.verdict}): ${report.findings.length} finding(s)`,
    context: { findings: report.findings, thresholds },
    recommendation:
      report.verdict === 'red'
        ? 'Investigate before continuing unattended operation: run pnpm doctor and inspect recent traces.'
        : 'Review the findings during the next maintenance window; thresholds live in health-thresholds.json.',
    dedupe_key: `health-degradation:${report.verdict}`,
  });
  logger.warn(`[health-degradation] ${report.verdict}: ${report.findings.length} finding(s)`);
  return { report, alert };
}
