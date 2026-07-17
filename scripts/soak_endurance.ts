import * as path from 'node:path';
import {
  logger,
  MetricsCollector,
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeStat,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { runAutoCheckpoint } from './auto_checkpoint.js';
import { scanTenantDrift } from './watch_tenant_drift.js';

export interface SoakSample {
  cycle: number;
  timestamp: string;
  duration_ms: number;
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  open_handles: number;
  sampled_files: Record<string, number>;
}

export interface SoakRegressionFinding {
  resource: string;
  slope_per_cycle: number;
  first_value: number;
  last_value: number;
  growth: number;
  sample_count: number;
  suspected_source: string;
  threshold_per_cycle: number;
}

export interface SoakReport {
  timestamp: string;
  cycles: number;
  sample_paths: string[];
  samples: SoakSample[];
  resource_regressions: SoakRegressionFinding[];
  latency_regressions: Array<Record<string, unknown>>;
  maintenance_summary: {
    auto_checkpoint_runs: number;
    tenant_drift_findings: number;
  };
  evidence: {
    run_log_path: string;
    summary_path: string;
    window_mode: 'compressed';
    window_days_equivalent: number;
  };
}

export interface SoakEvidenceValidation {
  ok: boolean;
  issues: string[];
  regression_count: number;
  evidence_files: string[];
}

function isActionableRegression(finding: SoakRegressionFinding): boolean {
  if (finding.suspected_source === 'history_bloat' || finding.suspected_source === 'cache_growth') {
    return true;
  }
  if (finding.suspected_source === 'unreleased_handles') return finding.growth >= 1;
  if (finding.suspected_source === 'heap_growth' || finding.suspected_source === 'process_growth') {
    // A runtime warm-up can add a small amount of heap/RSS over the first few
    // cycles. Require a sustained five-percent increase before failing the
    // autonomous gate; larger leaks still fail well before a 30-day window.
    return finding.growth > Math.max(1, finding.first_value * 0.05);
  }
  return true;
}

export interface SoakHarnessOptions {
  cycles?: number;
  delayMs?: number;
  samplePaths?: string[];
  reportPath?: string;
  metricsDir?: string;
  metricsFile?: string;
  evidenceRetentionCount?: number;
  failOnRegression?: boolean;
  quiet?: boolean;
  exercise?: (cycle: number) => Promise<void> | void;
}

const DEFAULT_SAMPLE_PATHS = [
  pathResolver.shared('runtime/mission-journal.jsonl'),
  pathResolver.shared('runtime/vuln-ledger.jsonl'),
  pathResolver.shared('runtime/auto-checkpoint.jsonl'),
  pathResolver.shared('runtime/baseline-check-cache/tenant-drift.json'),
];
const DEFAULT_REPORT_PATH = pathResolver.sharedTmp('soak-endurance/soak-report.json');
const DEFAULT_METRICS_DIR = pathResolver.sharedTmp('soak-endurance');
const DEFAULT_METRICS_FILE = 'latency-history.jsonl';

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activeHandleCount(): number {
  const candidate = process as typeof process & {
    _getActiveHandles?: () => unknown[];
  };
  if (typeof candidate._getActiveHandles !== 'function') return 0;
  try {
    return candidate._getActiveHandles().length;
  } catch {
    return 0;
  }
}

function sampleFileSizes(samplePaths: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const samplePath of samplePaths) {
    try {
      if (!safeExistsSync(samplePath)) {
        result[samplePath] = 0;
        continue;
      }
      result[samplePath] = safeStat(samplePath).size;
    } catch {
      result[samplePath] = 0;
    }
  }
  return result;
}

function captureSample(cycle: number, samplePaths: string[], durationMs: number): SoakSample {
  const mem = process.memoryUsage();
  return {
    cycle,
    timestamp: new Date().toISOString(),
    duration_ms: durationMs,
    rss_mb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    heap_used_mb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
    heap_total_mb: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
    open_handles: activeHandleCount(),
    sampled_files: sampleFileSizes(samplePaths),
  };
}

function leastSquaresSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  const xs = values.map((_, index) => index);
  const sumX = xs.reduce((sum, value) => sum + value, 0);
  const sumY = values.reduce((sum, value) => sum + value, 0);
  const sumXY = values.reduce((sum, value, index) => sum + value * xs[index], 0);
  const sumX2 = xs.reduce((sum, value) => sum + value * value, 0);
  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

function classifyResource(resource: string): string {
  const normalized = resource.toLowerCase();
  if (normalized.includes('handle')) return 'unreleased_handles';
  if (normalized.includes('cache')) return 'cache_growth';
  if (
    normalized.includes('journal') ||
    normalized.includes('history') ||
    normalized.includes('ledger')
  )
    return 'history_bloat';
  if (normalized.includes('rss')) return 'process_growth';
  if (normalized.includes('heap')) return 'heap_growth';
  return 'resource_growth';
}

function buildSeries(samples: SoakSample[], selector: (sample: SoakSample) => number): number[] {
  return samples.map((sample) => selector(sample));
}

function detectSeriesRegression(
  resource: string,
  samples: SoakSample[],
  selector: (sample: SoakSample) => number,
  thresholdPerCycle: number
): SoakRegressionFinding | null {
  const values = buildSeries(samples, selector);
  if (values.length < 4) return null;
  const firstValue = values[0];
  const lastValue = values[values.length - 1];
  const slope = leastSquaresSlope(values);
  if (slope <= thresholdPerCycle) return null;
  if (lastValue <= firstValue) return null;
  return {
    resource,
    slope_per_cycle: Math.round(slope * 1000) / 1000,
    first_value: Math.round(firstValue * 100) / 100,
    last_value: Math.round(lastValue * 100) / 100,
    growth: Math.round((lastValue - firstValue) * 100) / 100,
    sample_count: values.length,
    suspected_source: classifyResource(resource),
    threshold_per_cycle: thresholdPerCycle,
  };
}

export function detectResourceRegressions(samples: SoakSample[]): SoakRegressionFinding[] {
  const findings: SoakRegressionFinding[] = [];
  const numericThresholds: Array<{
    resource: keyof Pick<SoakSample, 'rss_mb' | 'heap_used_mb' | 'heap_total_mb' | 'open_handles'>;
    threshold: number;
  }> = [
    { resource: 'rss_mb', threshold: 0.08 },
    { resource: 'heap_used_mb', threshold: 0.08 },
    { resource: 'heap_total_mb', threshold: 0.08 },
    { resource: 'open_handles', threshold: 0.15 },
  ];

  for (const { resource, threshold } of numericThresholds) {
    const finding = detectSeriesRegression(
      resource,
      samples,
      (sample) => sample[resource],
      threshold
    );
    if (finding) findings.push(finding);
  }

  const trackedPaths = new Set<string>();
  for (const sample of samples) {
    for (const samplePath of Object.keys(sample.sampled_files)) {
      trackedPaths.add(samplePath);
    }
  }

  for (const samplePath of trackedPaths) {
    const finding = detectSeriesRegression(
      samplePath,
      samples,
      (sample) => sample.sampled_files[samplePath] ?? 0,
      1024
    );
    if (finding) findings.push(finding);
  }

  return findings;
}

function appendLatencyHistory(metricsDir: string, metricsFile: string, durationMs: number): void {
  safeMkdir(metricsDir, { recursive: true });
  safeAppendFileSync(
    path.join(metricsDir, metricsFile),
    JSON.stringify({
      skill: 'ao-04-soak-cycle',
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
    }) + '\n'
  );
}

function renderEvidenceSummary(report: SoakReport): string {
  const regressions =
    report.resource_regressions.length + report.latency_regressions.length > 0
      ? 'regressions detected'
      : 'no regressions detected';
  return [
    '# 30-day soak run summary',
    '',
    `- timestamp: ${report.timestamp}`,
    `- cycles: ${report.cycles}`,
    `- window mode: compressed (not a production 30-day window)`,
    `- equivalent days: ${report.evidence.window_days_equivalent}`,
    `- auto-checkpoint runs: ${report.maintenance_summary.auto_checkpoint_runs}`,
    `- tenant drift findings: ${report.maintenance_summary.tenant_drift_findings}`,
    `- resource regressions: ${report.resource_regressions.length}`,
    `- latency regressions: ${report.latency_regressions.length}`,
    `- status: ${regressions}`,
  ].join('\n');
}

export function validateSoakEvidence(report: SoakReport): SoakEvidenceValidation {
  const issues: string[] = [];
  const actionableResourceRegressions = report.resource_regressions.filter(isActionableRegression);
  const regressionCount = actionableResourceRegressions.length + report.latency_regressions.length;

  if (report.cycles < 4) {
    issues.push('at least 4 cycles are required for a meaningful trend');
  }
  if (!report.evidence.run_log_path || !safeExistsSync(report.evidence.run_log_path)) {
    issues.push('30-day run log artifact is missing');
  }
  if (!report.evidence.summary_path || !safeExistsSync(report.evidence.summary_path)) {
    issues.push('30-day run summary artifact is missing');
  }
  if (regressionCount > 0) {
    issues.push(`${regressionCount} resource or latency regression(s) detected`);
  }

  return {
    ok: issues.length === 0,
    issues,
    regression_count: regressionCount,
    evidence_files: [report.evidence.run_log_path, report.evidence.summary_path].filter(Boolean),
  };
}

function sanitizeEvidenceLabel(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : 'resource';
}

function createEvidenceBundlePaths(report: SoakReport): {
  dir: string;
  logPath: string;
  summaryPath: string;
} {
  const stamp = report.timestamp.replace(/[:.]/g, '-');
  const dir = pathResolver.sharedTmp(path.join('soak-evidence', `${stamp}-${process.pid}`));
  return {
    dir,
    logPath: path.join(dir, '30day-run-log.jsonl'),
    summaryPath: path.join(dir, '30day-run-summary.md'),
  };
}

function appendEvidenceBundle(report: SoakReport): void {
  const { dir, logPath, summaryPath } = createEvidenceBundlePaths(report);
  safeMkdir(dir, { recursive: true });
  for (const sample of report.samples) {
    safeAppendFileSync(
      logPath,
      JSON.stringify({
        run_timestamp: report.timestamp,
        cycle: sample.cycle,
        timestamp: sample.timestamp,
        maintenance_summary: report.maintenance_summary,
        resource_snapshot: {
          ...sample,
          sampled_files: Object.fromEntries(
            Object.entries(sample.sampled_files).map(([samplePath, size]) => [
              sanitizeEvidenceLabel(path.basename(samplePath)),
              size,
            ])
          ),
        },
      }) + '\n'
    );
  }
  safeWriteFile(summaryPath, renderEvidenceSummary(report));
  report.evidence.run_log_path = logPath;
  report.evidence.summary_path = summaryPath;
}

function applyEvidenceRollover(filePath: string, retentionCount: number): void {
  if (!Number.isFinite(retentionCount) || retentionCount <= 0) return;
  if (!safeExistsSync(filePath)) return;
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= retentionCount) return;
  safeWriteFile(filePath, lines.slice(-retentionCount).join('\n') + '\n');
}

async function runDefaultMaintenancePulse(): Promise<{
  autoCheckpointRan: boolean;
  tenantDriftFindings: number;
}> {
  let tenantDriftFindings = 0;
  let autoCheckpointRan = false;
  try {
    const drift = scanTenantDrift();
    tenantDriftFindings = drift.findings.length;
  } catch (error) {
    logger.warn(`[soak-endurance] tenant drift pulse failed: ${(error as Error).message ?? error}`);
  }
  try {
    await runAutoCheckpoint();
    autoCheckpointRan = true;
  } catch (error) {
    logger.warn(
      `[soak-endurance] auto checkpoint pulse failed: ${(error as Error).message ?? error}`
    );
  }
  return {
    autoCheckpointRan,
    tenantDriftFindings,
  };
}

export async function runSoakEnduranceHarness(
  options: SoakHarnessOptions = {}
): Promise<SoakReport> {
  const cycles = Math.max(1, Math.floor(options.cycles ?? 12));
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 0));
  const samplePaths = Array.from(
    new Set([...(options.samplePaths ?? []), ...DEFAULT_SAMPLE_PATHS])
  );
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const metricsDir = options.metricsDir ?? DEFAULT_METRICS_DIR;
  const metricsFile = options.metricsFile ?? DEFAULT_METRICS_FILE;
  const evidenceRetentionCount = Math.max(1, Math.floor(options.evidenceRetentionCount ?? 30));
  const samples: SoakSample[] = [];
  let autoCheckpointRuns = 0;
  let tenantDriftFindings = 0;

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const startedAt = Date.now();
    try {
      if (options.exercise) {
        await options.exercise(cycle);
      } else {
        const pulse = await runDefaultMaintenancePulse();
        autoCheckpointRuns += pulse.autoCheckpointRan ? 1 : 0;
        tenantDriftFindings += pulse.tenantDriftFindings;
      }
    } finally {
      const durationMs = Math.max(0, Date.now() - startedAt);
      appendLatencyHistory(metricsDir, metricsFile, durationMs);
      samples.push(captureSample(cycle, samplePaths, durationMs));
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  const historyCollector = new MetricsCollector({
    metricsDir,
    metricsFile,
    persist: false,
  });
  const latencyRegressions = historyCollector.detectRegressions(1.2);
  const resourceRegressions = detectResourceRegressions(samples);
  const report: SoakReport = {
    timestamp: new Date().toISOString(),
    cycles,
    sample_paths: samplePaths,
    samples,
    resource_regressions: resourceRegressions,
    latency_regressions: latencyRegressions,
    maintenance_summary: {
      auto_checkpoint_runs: autoCheckpointRuns,
      tenant_drift_findings: tenantDriftFindings,
    },
    evidence: {
      run_log_path: '',
      summary_path: '',
      window_mode: 'compressed',
      window_days_equivalent: cycles,
    },
  };

  safeMkdir(path.dirname(reportPath), { recursive: true });
  safeWriteFile(reportPath, JSON.stringify(report, null, 2));
  appendEvidenceBundle(report);
  applyEvidenceRollover(report.evidence.run_log_path, evidenceRetentionCount);

  return report;
}

function parseArgs(argv: string[]): SoakHarnessOptions & { json: boolean } {
  const options: SoakHarnessOptions & { json: boolean } = {
    cycles: 12,
    delayMs: 0,
    samplePaths: [],
    reportPath: DEFAULT_REPORT_PATH,
    metricsDir: DEFAULT_METRICS_DIR,
    metricsFile: DEFAULT_METRICS_FILE,
    quiet: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--cycles':
        options.cycles = Number(argv[++i] || options.cycles);
        break;
      case '--delay-ms':
        options.delayMs = Number(argv[++i] || options.delayMs);
        break;
      case '--sample-path':
        options.samplePaths?.push(argv[++i] || '');
        break;
      case '--report-path':
        options.reportPath = argv[++i] || options.reportPath;
        break;
      case '--metrics-dir':
        options.metricsDir = argv[++i] || options.metricsDir;
        break;
      case '--metrics-file':
        options.metricsFile = argv[++i] || options.metricsFile;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--fail-on-regression':
        options.failOnRegression = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        break;
    }
  }

  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runSoakEnduranceHarness(options);
  const validation = validateSoakEvidence(report);

  if (!options.quiet) {
    logger.info(
      `[soak-endurance] completed ${report.cycles} cycle(s); regressions=${report.resource_regressions.length}; latency=${report.latency_regressions.length}; evidence=${validation.ok ? 'valid' : 'invalid'}`
    );
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  }
  if (options.failOnRegression && !validation.ok) {
    for (const issue of validation.issues) logger.error(`[soak-endurance] ${issue}`);
    return 1;
  }
  return 0;
}

const isDirect = process.argv[1] && /soak_endurance\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      logger.error(`[soak-endurance] failed: ${(error as Error).message ?? error}`);
      process.exit(1);
    }
  );
}
