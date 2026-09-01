import path from 'node:path';
import { metrics } from '@agent/core/metrics';
import { pathResolver } from '@agent/core/path-resolver';
import { traceLogDir } from '@agent/core/src/trace';
import { validateTraceReplay } from '@agent/core/trace-schema';
import { tailJsonl } from './tail.js';
import { theme, statusColor } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { PanelViewModel } from './types.js';

interface ComponentStats {
  count: number;
  errors: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

export interface TraceLine {
  name: string;
  status: string;
  startedAt: string;
  context: string;
}

export interface StatsData {
  components: Array<{ name: string } & ComponentStats>;
  regressions: string[];
  usageByKind: Array<{ kind: string; count: number }>;
  traces: TraceLine[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTraceRecord(value: unknown): Record<string, unknown> | null {
  return validateTraceReplay(value, { strictUnknownSpans: true }).length === 0 && isRecord(value)
    ? value
    : null;
}

function todaysTraceFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(traceLogDir(), `traces-${day}.jsonl`);
}

export function loadStats(): StatsData {
  let components: StatsData['components'] = [];
  try {
    const report: any = metrics.reportFromHistory();
    const bySkill: Record<string, ComponentStats> = report?.bySkill ?? report ?? {};
    components = Object.entries(bySkill)
      .filter(([, stats]) => typeof stats === 'object' && stats !== null && 'count' in stats)
      .map(([name, stats]) => ({ name, ...(stats as ComponentStats) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);
  } catch {
    // no metrics history yet
  }
  let regressions: string[] = [];
  try {
    const detected: any = metrics.detectRegressions();
    if (Array.isArray(detected)) {
      regressions = detected
        .slice(0, 5)
        .map((entry: any) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
    }
  } catch {
    // regression detection is best-effort
  }
  const usageCounts = new Map<string, number>();
  try {
    for (const record of metrics.loadResourceUsageHistory()) {
      const kind = String((record as any).kind ?? 'other');
      usageCounts.set(kind, (usageCounts.get(kind) ?? 0) + 1);
    }
  } catch {
    // no resource usage history yet
  }
  const traces = tailJsonl<Record<string, unknown>>(todaysTraceFile(), 10, parseTraceRecord).map(
    (trace) => {
      const rootSpan = isRecord(trace.rootSpan) ? trace.rootSpan : {};
      const metadata = isRecord(trace.metadata) ? trace.metadata : {};
      return {
        name: String(rootSpan.name ?? '-'),
        status: String(rootSpan.status ?? '-'),
        startedAt: String(metadata.startedAt ?? ''),
        context: String(metadata.pipelineId ?? metadata.actuator ?? ''),
      };
    }
  );
  return {
    components,
    regressions,
    usageByKind: [...usageCounts.entries()].map(([kind, count]) => ({ kind, count })),
    traces,
  };
}

export function statsWatchPaths(): string[] {
  return [traceLogDir(), pathResolver.resolve('work/metrics')];
}

export function statsViewModel(data: StatsData, i18n: I18n): PanelViewModel {
  const sections = [];
  if (data.traces.length > 0) {
    sections.push({
      title: i18n.tr('tui:tui_stats_traces'),
      lines: data.traces.map(
        (trace) =>
          `${trace.status === 'ok' ? '●' : trace.status === 'error' ? '✖' : '…'} ${trace.name}  ${trace.context}  ${trace.startedAt}`
      ),
    });
  }
  if (data.usageByKind.length > 0) {
    sections.push({
      title: i18n.tr('tui:tui_stats_cost'),
      lines: data.usageByKind.map((usage) => `${usage.kind}: ${usage.count}`),
    });
  }
  if (data.regressions.length > 0) {
    sections.push({
      title: i18n.tr('tui:tui_stats_regressions'),
      lines: data.regressions,
    });
  }
  return {
    columns: [i18n.tr('tui:tui_stats_metrics'), 'n', 'err', 'avg ms', 'max ms'],
    rows: data.components.map((component) => ({
      id: component.name,
      color: component.errors > 0 ? theme.warn : statusColor('ready'),
      cells: [
        component.name,
        String(component.count),
        String(component.errors),
        String(component.count > 0 ? Math.round(component.totalMs / component.count) : 0),
        String(Math.round(component.maxMs)),
      ],
    })),
    sections,
  };
}
