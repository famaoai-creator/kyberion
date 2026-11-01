import { appendJsonLine } from '../foundation/json.js';
import * as path from 'node:path';
import { logger } from '../core.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { fileEndsWithNewline, readJsonLinesSince } from '../jsonl-read.js';
import { maintainStoreAfterAppend } from '../append-only-store.js';
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
 * file. Malformed, torn and schema-invalid lines are skipped.
 */
export function loadRuntimeHealthSamples(
  windowMs: number,
  now = Date.now()
): RuntimeHealthSample[] {
  const filePath = historyPath();
  if (!safeExistsSync(filePath)) return [];
  ensureRegularHistoryFile(filePath);
  const since = now - windowMs;
  const catalog = healthSampleCatalog(filePath);
  return readJsonLinesSince<RuntimeHealthSample | null>(filePath, {
    onMalformed: 'skip',
    map: (value, lineNumber) => catalog.validate(value, `${filePath}:${lineNumber}`),
    timeOf: sampleTime,
    sinceMs: since,
  }).filter((sample): sample is RuntimeHealthSample => {
    const at = sampleTime(sample);
    return at !== undefined && at >= since;
  });
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

    if (first.rss_mb > 0) {
      const ratio = last.rss_mb / first.rss_mb;
      if (ratio >= thresholds.rss_growth_warning_ratio) {
        findings.push({
          kind: 'rss_growth',
          severity: ratio >= thresholds.rss_growth_red_ratio ? 'critical' : 'warning',
          detail: `${processName}: RSS ${first.rss_mb}MB → ${last.rss_mb}MB (${ratio.toFixed(2)}x) in the window`,
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
