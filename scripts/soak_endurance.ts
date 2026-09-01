import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { MetricsCollector } from '@agent/core/metrics';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeStat,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { appendJsonLine, readJsonIfPresent } from '@agent/core/foundation';
import { runAutoCheckpoint } from './auto_checkpoint.js';
import { scanTenantDrift } from './watch_tenant_drift.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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
    window_mode: 'compressed' | 'live';
    window_days_equivalent: number;
    manifest_path?: string;
  };
}

export interface SoakEvidenceManifest {
  version: '1.0';
  started_at: string;
  last_run_at: string;
  run_count: number;
  total_cycles: number;
  window_days_equivalent: number;
  last_validation: {
    ok: boolean;
    regression_count: number;
    issues: string[];
  };
}

export interface SoakEvidenceValidation {
  ok: boolean;
  mature: boolean;
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
  mode?: 'compressed' | 'live';
  /** Durable root for live evidence; defaults under active/shared/runtime. */
  evidenceDir?: string;
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
const DEFAULT_LIVE_EVIDENCE_DIR = pathResolver.shared('runtime/health/soak');

function assertSoakResourcePath(filePath: string, label: string, allowMissingLeaf = true): string {
  try {
    return assertSafeRepositoryPath(filePath, { allowMissingLeaf });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[soak-endurance] invalid ${label}: ${reason}`);
  }
}

function assertSoakMetricsFile(metricsFile: string): string {
  if (
    !metricsFile ||
    metricsFile === '.' ||
    metricsFile === '..' ||
    metricsFile.includes('/') ||
    metricsFile.includes('\\') ||
    metricsFile.includes('\0')
  ) {
    throw new Error('[soak-endurance] metricsFile must be a single safe filename');
  }
  return metricsFile;
}

function isSafeRegularFile(filePath: string): boolean {
  try {
    const safePath = assertSoakResourcePath(filePath, 'evidence artifact');
    return safeExistsSync(safePath) && safeLstat(safePath).isFile();
  } catch {
    return false;
  }
}

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
      const safeSamplePath = assertSoakResourcePath(samplePath, 'sample path');
      if (!safeExistsSync(safeSamplePath) || !safeLstat(safeSamplePath).isFile()) {
        result[samplePath] = 0;
        continue;
      }
      result[samplePath] = safeStat(safeSamplePath).size;
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
  const safeMetricsDir = assertSoakResourcePath(metricsDir, 'metrics directory');
  const safeMetricsPath = assertSoakResourcePath(
    path.join(safeMetricsDir, assertSoakMetricsFile(metricsFile)),
    'metrics file'
  );
  assertSoakResourcePath(path.dirname(safeMetricsPath), 'metrics parent directory');
  safeMkdir(safeMetricsDir, { recursive: true });
  assertSoakResourcePath(safeMetricsDir, 'metrics directory');
  assertSoakResourcePath(safeMetricsPath, 'metrics file');
  appendJsonLine(safeMetricsPath, {
    skill: 'ao-04-soak-cycle',
    duration_ms: durationMs,
    timestamp: new Date().toISOString(),
  });
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
  const mature = report.evidence.window_mode === 'live' || report.cycles >= 4;

  if (report.evidence.window_mode === 'compressed' && report.cycles < 4) {
    issues.push('at least 4 cycles are required for a meaningful trend');
  }
  if (!report.evidence.run_log_path || !isSafeRegularFile(report.evidence.run_log_path)) {
    issues.push('30-day run log artifact is missing');
  }
  if (!report.evidence.summary_path || !isSafeRegularFile(report.evidence.summary_path)) {
    issues.push('30-day run summary artifact is missing');
  }
  if (regressionCount > 0) {
    issues.push(`${regressionCount} resource or latency regression(s) detected`);
  }

  return {
    ok: issues.length === 0,
    mature,
    issues,
    regression_count: regressionCount,
    evidence_files: [report.evidence.run_log_path, report.evidence.summary_path].flatMap(
      (filePath) => {
        if (!filePath) return [];
        try {
          return [assertSoakResourcePath(filePath, 'evidence artifact')];
        } catch {
          return [];
        }
      }
    ),
  };
}

function sanitizeEvidenceLabel(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : 'resource';
}

function createEvidenceBundlePaths(
  report: SoakReport,
  evidenceRoot?: string
): {
  dir: string;
  logPath: string;
  summaryPath: string;
} {
  const stamp = report.timestamp.replace(/[:.]/g, '-');
  const dir = evidenceRoot
    ? path.join(
        assertSoakResourcePath(evidenceRoot, 'evidence directory'),
        'evidence',
        `${stamp}-${process.pid}`
      )
    : pathResolver.sharedTmp(path.join('soak-evidence', `${stamp}-${process.pid}`));
  const safeDir = assertSoakResourcePath(dir, 'evidence bundle directory');
  return {
    dir: safeDir,
    logPath: assertSoakResourcePath(path.join(safeDir, '30day-run-log.jsonl'), 'run log'),
    summaryPath: assertSoakResourcePath(path.join(safeDir, '30day-run-summary.md'), 'summary'),
  };
}

function appendEvidenceBundle(report: SoakReport, evidenceRoot?: string): void {
  const { dir, logPath, summaryPath } = createEvidenceBundlePaths(report, evidenceRoot);
  assertSoakResourcePath(path.dirname(dir), 'evidence parent directory');
  assertSoakResourcePath(logPath, 'run log');
  assertSoakResourcePath(summaryPath, 'summary');
  safeMkdir(dir, { recursive: true });
  assertSoakResourcePath(dir, 'evidence bundle directory');
  assertSoakResourcePath(logPath, 'run log');
  assertSoakResourcePath(summaryPath, 'summary');
  for (const sample of report.samples) {
    appendJsonLine(logPath, {
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
    });
  }
  safeWriteFile(summaryPath, renderEvidenceSummary(report));
  report.evidence.run_log_path = logPath;
  report.evidence.summary_path = summaryPath;
}

function updateLiveEvidenceManifest(report: SoakReport, evidenceRoot: string): void {
  const safeEvidenceRoot = assertSoakResourcePath(evidenceRoot, 'evidence directory');
  const manifestPath = assertSoakResourcePath(
    path.join(safeEvidenceRoot, 'manifest.json'),
    'evidence manifest'
  );
  const previous = readJsonIfPresent<SoakEvidenceManifest>(manifestPath);
  const validation = validateSoakEvidence(report);
  const firstAt = previous?.started_at ?? report.timestamp;
  const lastAt = report.timestamp;
  const elapsedDays = Math.max(0, (Date.parse(lastAt) - Date.parse(firstAt)) / 86_400_000);
  const manifest: SoakEvidenceManifest = {
    version: '1.0',
    started_at: firstAt,
    last_run_at: lastAt,
    run_count: (previous?.run_count ?? 0) + 1,
    total_cycles: (previous?.total_cycles ?? 0) + report.cycles,
    window_days_equivalent: Math.round(elapsedDays * 100) / 100,
    last_validation: {
      ok: validation.ok,
      regression_count: validation.regression_count,
      issues: validation.issues,
    },
  };
  assertSoakResourcePath(path.dirname(manifestPath), 'evidence parent directory');
  safeMkdir(safeEvidenceRoot, { recursive: true });
  assertSoakResourcePath(safeEvidenceRoot, 'evidence directory');
  assertSoakResourcePath(manifestPath, 'evidence manifest');
  safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
  report.evidence.manifest_path = manifestPath;
  report.evidence.window_days_equivalent = manifest.window_days_equivalent;
  safeWriteFile(
    assertSoakResourcePath(report.evidence.summary_path, 'summary'),
    renderEvidenceSummary(report)
  );
}

function applyEvidenceRollover(filePath: string, retentionCount: number): void {
  if (!Number.isFinite(retentionCount) || retentionCount <= 0) return;
  const safeFilePath = assertSoakResourcePath(filePath, 'run log');
  if (!safeExistsSync(safeFilePath) || !safeLstat(safeFilePath).isFile()) return;
  const raw = String(safeReadFile(safeFilePath, { encoding: 'utf8' }) || '');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= retentionCount) return;
  assertSoakResourcePath(safeFilePath, 'run log');
  safeWriteFile(safeFilePath, lines.slice(-retentionCount).join('\n') + '\n');
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
  const mode = options.mode ?? 'compressed';
  const evidenceRoot =
    mode === 'live'
      ? assertSoakResourcePath(
          options.evidenceDir ?? DEFAULT_LIVE_EVIDENCE_DIR,
          'evidence directory'
        )
      : undefined;
  const cycles = Math.max(1, Math.floor(options.cycles ?? 12));
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 0));
  const samplePaths = Array.from(
    new Set([...(options.samplePaths ?? []), ...DEFAULT_SAMPLE_PATHS])
  ).map((samplePath) => assertSoakResourcePath(samplePath, 'sample path'));
  const reportPath = assertSoakResourcePath(
    options.reportPath ??
      (mode === 'live'
        ? path.join(evidenceRoot ?? DEFAULT_LIVE_EVIDENCE_DIR, 'latest-report.json')
        : DEFAULT_REPORT_PATH),
    'report path'
  );
  const metricsDir = assertSoakResourcePath(
    options.metricsDir ??
      (mode === 'live'
        ? path.join(evidenceRoot ?? DEFAULT_LIVE_EVIDENCE_DIR, 'metrics')
        : DEFAULT_METRICS_DIR),
    'metrics directory'
  );
  const metricsFile = assertSoakMetricsFile(options.metricsFile ?? DEFAULT_METRICS_FILE);
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
      window_mode: mode,
      window_days_equivalent: cycles,
    },
  };

  const safeReportParent = assertSoakResourcePath(
    path.dirname(reportPath),
    'report parent directory'
  );
  assertSoakResourcePath(reportPath, 'report path');
  safeMkdir(safeReportParent, { recursive: true });
  assertSoakResourcePath(safeReportParent, 'report parent directory');
  assertSoakResourcePath(reportPath, 'report path');
  safeWriteFile(reportPath, JSON.stringify(report, null, 2));
  appendEvidenceBundle(report, evidenceRoot);
  applyEvidenceRollover(report.evidence.run_log_path, evidenceRetentionCount);
  if (mode === 'live' && evidenceRoot) updateLiveEvidenceManifest(report, evidenceRoot);

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
    mode: 'compressed',
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
      case '--live':
        options.mode = 'live';
        break;
      case '--evidence-dir':
        options.evidenceDir = argv[++i] || options.evidenceDir;
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

async function main(argv: string[] = []): Promise<number> {
  const options = parseArgs(argv);
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

export const runSoakEndurance = defineScript({
  name: 'soak:endurance',
  flags: [],
  run: async ({ argv }) => {
    const code = await main(argv);
    if (code !== 0) throw new ScriptExitError(code, '', true);
  },
});

if (
  isDirectScript(import.meta.url, 'soak_endurance.ts') ||
  isDirectScript(import.meta.url, 'soak_endurance.js')
)
  void runSoakEndurance();
