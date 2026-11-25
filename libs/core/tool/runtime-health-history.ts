import { appendJsonLine } from '../foundation/json.js';
import * as path from 'node:path';
import { logger } from '../core.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { fileEndsWithNewline, readJsonLinesSince } from '../storage/jsonl-read.js';
import { maintainStoreAfterAppend } from '../storage/append-only-store.js';
import { parkedCompactionCopies } from '../storage/jsonl-parked-read.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeMkdir } from '../secure-io.js';

/**
 * OP-04: durable RSS / restart history. The degradation watch could only
 * judge point-in-time signals (latency regressions, provider demotions);
 * slow leaks and restart storms need a trend over a window. Long-lived
 * processes append hourly samples here and the hourly watch evaluates the
 * window against health-thresholds.json.
 */

export interface RuntimeHealthSample {
  timestamp: string;
  process_name: string;
  rss_mb: number;
  heap_used_mb: number;
  /** Cumulative restart count per agent id at sample time (optional). */
  restarts?: Record<string, number>;
}

export interface RuntimeTrendFinding {
  kind: 'rss_growth' | 'restart_frequency';
  severity: 'warning' | 'critical';
  detail: string;
}

const HISTORY_RELATIVE = 'active/shared/runtime/health/runtime-health.jsonl';
/**
 * Write-time retention (explicit `window` policy — the catalog has no window
 * action): once the file passes the threshold, samples older than the
 * horizon are dropped (no archive — a lossy time series by design). Readers
 * need at most a day (health-thresholds `trend_window_ms`, the learning
 * harvest's 24h lookback); 30 days keeps a month of trend for operators.
 */
export const RUNTIME_HEALTH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RUNTIME_HEALTH_WINDOW_MIN_BYTES = 1024 * 1024;

interface RuntimeHealthStoreTuning {
  windowMinBytes?: number;
  /** Test seam: history location (default: the shared runtime path). */
  historyPath?: string;
}
let storeTuning: RuntimeHealthStoreTuning = {};

/** Test seam: override the window threshold / history path; `{}` resets. */
export function setRuntimeHealthStoreTuningForTests(tuning: RuntimeHealthStoreTuning): void {
  storeTuning = { ...tuning };
}

function sampleTime(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const at = Date.parse(String((value as { timestamp?: unknown }).timestamp ?? ''));
  return Number.isFinite(at) ? at : undefined;
}
const HEALTH_SAMPLE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/runtime-health-sample.schema.json'
);

function historyPath(): string {
  return assertSafeRepositoryPath(
    storeTuning.historyPath ?? pathResolver.rootResolve(HISTORY_RELATIVE),
    {
      allowMissingLeaf: true,
    }
  );
}

function healthSampleCatalog(filePath: string): GovernedCatalog<RuntimeHealthSample> {
  return defineCatalog<RuntimeHealthSample>({
    id: 'runtime-health-sample',
    path: filePath,
    schema: HEALTH_SAMPLE_SCHEMA_PATH,
  });
}

function ensureRegularHistoryFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`[runtime-health] history must be a regular file: ${filePath}`);
  }
}

export function recordRuntimeHealthSample(input: {
  processName: string;
  restarts?: Record<string, number>;
  now?: number;
}): RuntimeHealthSample {
  const usage = process.memoryUsage();
  const sample: RuntimeHealthSample = {
    timestamp: new Date(input.now ?? Date.now()).toISOString(),
    process_name: input.processName,
    rss_mb: Math.round((usage.rss / (1024 * 1024)) * 10) / 10,
    heap_used_mb: Math.round((usage.heapUsed / (1024 * 1024)) * 10) / 10,
    ...(input.restarts && Object.keys(input.restarts).length > 0
      ? { restarts: input.restarts }
      : {}),
  };
  try {
    const filePath = historyPath();
    safeMkdir(path.dirname(filePath), { recursive: true });
    ensureRegularHistoryFile(filePath);
    // A torn tail would swallow this sample into one unparseable line.
    appendJsonLine(filePath, healthSampleCatalog(filePath).validate(sample, filePath), {
      leadingNewline: !fileEndsWithNewline(filePath),
    });
    maintainStoreAfterAppend(
      filePath,
      {
        action: 'window',
        minBytes: storeTuning.windowMinBytes ?? RUNTIME_HEALTH_WINDOW_MIN_BYTES,
        windowMs: RUNTIME_HEALTH_RETENTION_MS,
        timeOf: sampleTime,
        archiveDir: null,
      },
      { now: new Date(input.now ?? Date.now()) }
    );
  } catch (err: any) {
    logger.warn(`[runtime-health] sample append failed: ${err?.message || err}`);
  }
  return sample;
}

/**
 * Samples at or after `now - windowMs`, oldest first. A backward scan that
 * stops at the first older sample, so the cost tracks the window, not the
 * file. Malformed, torn and schema-invalid lines are skipped. While a window
 * rewrite has the file parked (the live file missing, or recreated by an
 * append with only the newest samples), the parked copies' windows are read
 * too; samples repeated between a copy and the published file count once.
 */
export function loadRuntimeHealthSamples(
  windowMs: number,
  now = Date.now()
): RuntimeHealthSample[] {
  const filePath = historyPath();
  const copies = parkedCompactionCopies(filePath);
  const liveExists = safeExistsSync(filePath);
  if (!liveExists && copies.length === 0) return [];
  if (liveExists) ensureRegularHistoryFile(filePath);
  const since = now - windowMs;
  const catalog = healthSampleCatalog(filePath);
  const windowOf = (file: string): RuntimeHealthSample[] =>
    readJsonLinesSince<RuntimeHealthSample | null>(file, {
      onMalformed: 'skip',
      map: (value, lineNumber) => catalog.validate(value, `${file}:${lineNumber}`),
      timeOf: sampleTime,
      sinceMs: since,
    }).filter((sample): sample is RuntimeHealthSample => {
      const at = sampleTime(sample);
      return at !== undefined && at >= since;
    });
  if (copies.length === 0) return windowOf(filePath);
  const seen = new Set<string>();
  const samples: RuntimeHealthSample[] = [];
  for (const file of [...copies, filePath]) {
    for (const sample of windowOf(file)) {
      const key = JSON.stringify(sample);
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push(sample);
    }
  }
  // Stable: equal timestamps keep file order (copies before the live file).
  return samples.sort((a, b) => (sampleTime(a) ?? 0) - (sampleTime(b) ?? 0));
}

export interface RuntimeTrendThresholds {
  rss_growth_warning_ratio: number;
  rss_growth_red_ratio: number;
  restart_warning_count: number;
  restart_red_count: number;
}

export function evaluateRuntimeHealthTrends(
  samples: RuntimeHealthSample[],
  thresholds: RuntimeTrendThresholds
): RuntimeTrendFinding[] {
  const findings: RuntimeTrendFinding[] = [];
  const byProcess = new Map<string, RuntimeHealthSample[]>();
  for (const sample of samples) {
    const list = byProcess.get(sample.process_name) ?? [];
    list.push(sample);
    byProcess.set(sample.process_name, list);
  }

  for (const [processName, list] of byProcess) {
    if (list.length < 2) continue;
    const first = list[0];
    const last = list[list.length - 1];

    // RSS of a GC'd process saw-tooths, and on macOS a sample taken right
    // after the host wakes is paged out (tens of MB). First-vs-last of single
    // samples reads that noise as growth, so compare the upper quartile of the
    // first and last thirds of the window (robust to paged-out dips) and
    // require a minimum absolute increase. A one-off spike in the last third
    // (a heavy in-process job) still lifts that quartile, so the growth must
    // also show in the heap floor — the lower quartile of heap_used, which a
    // JS leak raises because live objects survive every GC, while a spike does
    // not. The RSS floor is not used: paged-out samples after macOS sleep are
    // common enough (3 of 8 in one third) to fake a rising RSS floor. Off-heap
    // (native/Buffer) growth is therefore not reported here.
    const span = Math.max(1, Math.floor(list.length / 3));
    const head = list.slice(0, span);
    const tail = list.slice(-span);
    const before = upperQuartileOf(head.map((s) => s.rss_mb));
    const after = upperQuartileOf(tail.map((s) => s.rss_mb));
    if (before > 0 && after - before >= RSS_GROWTH_MIN_DELTA_MB) {
      const ratio = after / before;
      const heapFrom = lowerQuartileOf(head.map((s) => s.heap_used_mb));
      const heapTo = lowerQuartileOf(tail.map((s) => s.heap_used_mb));
      const heapFloorRose =
        heapFrom > 0 &&
        heapTo - heapFrom >= RSS_GROWTH_MIN_DELTA_MB &&
        heapTo / heapFrom >= thresholds.rss_growth_warning_ratio;
      if (ratio >= thresholds.rss_growth_warning_ratio && heapFloorRose) {
        const label = span > 1 ? ` (upper quartile of ${span} samples each end)` : '';
        const heap = `; heap floor ${heapFrom}MB → ${heapTo}MB`;
        findings.push({
          kind: 'rss_growth',
          severity: ratio >= thresholds.rss_growth_red_ratio ? 'critical' : 'warning',
          detail: `${processName}: RSS ${before}MB → ${after}MB (${ratio.toFixed(2)}x) in the window${label}${heap}`,
        });
      }
    }

    const restartDelta = sumRestartDelta(first.restarts, last.restarts);
    if (restartDelta >= thresholds.restart_warning_count) {
      findings.push({
        kind: 'restart_frequency',
        severity: restartDelta >= thresholds.restart_red_count ? 'critical' : 'warning',
        detail: `${processName}: ${restartDelta} agent restart(s) in the window`,
      });
    }
  }
  return findings;
}

/** Growth smaller than this (MB) is never reported, whatever the ratio. */
export const RSS_GROWTH_MIN_DELTA_MB = 50;

/** Nearest-rank 25th percentile. */
function lowerQuartileOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.25) - 1)]!;
}

/** Nearest-rank 75th percentile. */
function upperQuartileOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)]!;
}

function sumRestartDelta(
  first: Record<string, number> | undefined,
  last: Record<string, number> | undefined
): number {
  if (!last) return 0;
  let delta = 0;
  for (const [agentId, count] of Object.entries(last)) {
    const before = first?.[agentId] ?? 0;
    if (count > before) delta += count - before;
  }
  return delta;
}
