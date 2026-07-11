import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';

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
const MAX_LINES = 5000;
const KEEP_LINES = 2500;

function historyPath(): string {
  return pathResolver.rootResolve(HISTORY_RELATIVE);
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
    safeAppendFileSync(filePath, `${JSON.stringify(sample)}\n`, 'utf8');
    pruneIfOversized(filePath);
  } catch (err: any) {
    logger.warn(`[runtime-health] sample append failed: ${err?.message || err}`);
  }
  return sample;
}

function pruneIfOversized(filePath: string): void {
  try {
    const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    safeWriteFile(filePath, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
  } catch {
    /* prune is best-effort housekeeping */
  }
}

export function loadRuntimeHealthSamples(
  windowMs: number,
  now = Date.now()
): RuntimeHealthSample[] {
  const filePath = historyPath();
  if (!safeExistsSync(filePath)) return [];
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  const since = now - windowMs;
  const samples: RuntimeHealthSample[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RuntimeHealthSample;
      const at = Date.parse(parsed.timestamp || '');
      if (Number.isFinite(at) && at >= since) samples.push(parsed);
    } catch {
      /* skip malformed lines */
    }
  }
  return samples;
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
