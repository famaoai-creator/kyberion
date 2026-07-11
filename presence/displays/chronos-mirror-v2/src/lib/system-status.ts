import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

import { collectTraceFeed } from './trace-feed';

/**
 * OP-04 Task 2 — aggregated system health for the /api/status endpoint.
 *
 * v1 aggregates the signals that are cheaply available from runtime files:
 * process uptime, persisted provider demotions (OP-04 Task 3), and the last
 * hour of pipeline traces. Extension points (mesh backlog AA-02, backup
 * recency OP-02, daily cost OP-01) plug into collectSystemStatus as their
 * runtime surfaces stabilise.
 */

export interface ProviderDemotionStatus {
  provider: string;
  instance: string;
  until: number;
  reason: string;
}

export interface TraceWindowSummary {
  total: number;
  errors: number;
  error_rate: number;
}

export interface SystemStatusReport {
  generated_at: string;
  uptime_seconds: number;
  rollup: 'green' | 'yellow' | 'red';
  reasons: string[];
  provider_health: { demoted: ProviderDemotionStatus[] };
  traces_last_hour: TraceWindowSummary;
}

const TRACE_WINDOW_MS = 60 * 60 * 1000;
const RED_ERROR_RATE = 0.5;
const RED_MIN_SAMPLES = 5;

export function collectProviderDemotions(
  now: number = Date.now(),
  statePath: string = pathResolver.active('shared/runtime/provider-health.json')
): ProviderDemotionStatus[] {
  if (!safeExistsSync(statePath)) return [];
  try {
    const parsed = JSON.parse(String(safeReadFile(statePath, { encoding: 'utf8' }) || '{}')) as {
      demotions?: ProviderDemotionStatus[];
    };
    return (parsed.demotions || []).filter(
      (entry) => entry?.provider && Number.isFinite(entry.until) && entry.until > now
    );
  } catch {
    return [];
  }
}

export function summarizeTraceWindow(
  entries: Array<{ startedAt: string; status: string }>,
  now: number = Date.now()
): TraceWindowSummary {
  const windowStart = now - TRACE_WINDOW_MS;
  const recent = entries.filter((entry) => {
    const started = new Date(entry.startedAt).getTime();
    return Number.isFinite(started) && started >= windowStart && started <= now;
  });
  const errors = recent.filter((entry) => entry.status === 'error').length;
  return {
    total: recent.length,
    errors,
    error_rate: recent.length > 0 ? errors / recent.length : 0,
  };
}

export function buildSystemStatusReport(input: {
  now?: number;
  uptimeSeconds?: number;
  demoted: ProviderDemotionStatus[];
  traces: TraceWindowSummary;
}): SystemStatusReport {
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  let rollup: SystemStatusReport['rollup'] = 'green';

  if (input.demoted.length > 0) {
    rollup = 'yellow';
    reasons.push(
      `${input.demoted.length} provider instance(s) demoted: ${input.demoted
        .map((entry) => `${entry.provider}#${entry.instance}`)
        .join(', ')}`
    );
  }
  if (input.traces.errors > 0) {
    rollup = 'yellow';
    reasons.push(`${input.traces.errors}/${input.traces.total} trace(s) errored in the last hour`);
  }
  if (input.traces.total >= RED_MIN_SAMPLES && input.traces.error_rate >= RED_ERROR_RATE) {
    rollup = 'red';
    reasons.push(
      `error rate ${(input.traces.error_rate * 100).toFixed(0)}% over the last hour exceeds ${RED_ERROR_RATE * 100}%`
    );
  }
  if (reasons.length === 0) {
    reasons.push('no demoted providers and no trace errors in the last hour');
  }

  return {
    generated_at: new Date(now).toISOString(),
    uptime_seconds: Math.round(input.uptimeSeconds ?? process.uptime()),
    rollup,
    reasons,
    provider_health: { demoted: input.demoted },
    traces_last_hour: input.traces,
  };
}

export function collectSystemStatus(now: number = Date.now()): SystemStatusReport {
  const demoted = collectProviderDemotions(now);
  const feed = collectTraceFeed({ limit: 200 });
  const traces = summarizeTraceWindow(
    feed.map((entry) => ({ startedAt: entry.startedAt, status: entry.status })),
    now
  );
  return buildSystemStatusReport({ now, demoted, traces });
}
