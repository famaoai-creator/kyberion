import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditChain,
  customerResolver,
  createStandardYargs,
  loadIntentContractMemorySnapshot,
  renderStatus,
  resolveVocabularyLocale,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  pathResolver,
} from '@agent/core';
import type { AuditEntry, IntentContractMemoryEntry, Trace } from '@agent/core';
import { listMissionsInSearchDirs, loadState } from './refactor/mission-state.js';
import type { MissionState } from './refactor/mission-types.js';

type IntentTraceSource = 'mission' | 'snapshot' | 'delta' | 'memory' | 'trace' | 'audit';

interface IntentTraceRow {
  timestamp: string;
  source: IntentTraceSource;
  label: string;
  summary: string;
  refs: string[];
}

interface IntentTraceMissionHit {
  missionId: string;
  missionPath: string;
  state: MissionState;
  evidencePath: string | null;
  matchedCorrelationId: string;
}

interface IntentTraceSnapshotHit {
  missionId: string;
  filePath: string;
  snapshot: Record<string, any>;
}

interface IntentTraceDeltaHit {
  missionId: string;
  filePath: string;
  delta: Record<string, any>;
}

interface IntentTraceTraceHit {
  filePath: string;
  trace: Trace;
}

interface IntentTraceReportData {
  correlationId: string;
  locale: string;
  missions: IntentTraceMissionHit[];
  snapshots: IntentTraceSnapshotHit[];
  deltas: IntentTraceDeltaHit[];
  memoryEntries: IntentContractMemoryEntry[];
  traces: IntentTraceTraceHit[];
  auditEntries: AuditEntry[];
}

interface IntentTraceFormatOptions {
  locale?: string;
  maxRows?: number;
}

interface IntentTraceCollectOptions {
  locale?: string;
  traceDir?: string;
  missionRoots?: Array<{ missionId: string; missionPath: string }>;
  loadMissionState?: (missionId: string) => MissionState | null;
  loadMemory?: () => { entries: IntentContractMemoryEntry[] };
  loadAuditEntries?: () => AuditEntry[];
}

function normalizeTimestamp(value?: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '1970-01-01T00:00:00.000Z';
  return value;
}

function safeJsonLines(filePath: string): Array<Record<string, any>> {
  if (!safeExistsSync(filePath)) return [];
  const raw = safeReadFile(filePath, { encoding: 'utf8', label: filePath }) as string;
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' ? [parsed as Record<string, any>] : [];
      } catch {
        return [];
      }
    });
}

function compactText(value: unknown, maxLength = 96): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function shouldRedact(state: MissionState | null | undefined): boolean {
  return (state?.tier || 'confidential') !== 'public';
}

function summarizeMissionState(state: MissionState, redact: boolean): string {
  const parts = [
    `mission=${state.mission_id}`,
    `status=${renderStatus('mission', state.status, resolveVocabularyLocale(process.env.LANG))}`,
  ];
  if (state.correlation_id) parts.push(`correlation=${state.correlation_id}`);
  if (state.origin_intent_id) parts.push(`origin_intent=${state.origin_intent_id}`);
  if (state.origin_utterance_ref) parts.push(`utterance_ref=${state.origin_utterance_ref}`);
  if (state.intent?.goal_summary) {
    parts.push(redact ? 'goal=[redacted]' : `goal=${compactText(state.intent.goal_summary)}`);
  }
  if (state.intent?.success_condition) {
    parts.push(
      redact
        ? 'success_condition=[redacted]'
        : `success=${compactText(state.intent.success_condition)}`
    );
  }
  return parts.join(' ');
}

function toSafeRef(value: string): string {
  return pathResolver.toRepoRelative(value);
}

function extractMissionCorrelationIds(state: MissionState): string[] {
  const ids = new Set<string>();
  if (typeof state.correlation_id === 'string' && state.correlation_id.trim()) {
    ids.add(state.correlation_id.trim());
  }
  for (const entry of state.history || []) {
    const correlationId = entry.handoff_packet?.correlation_id;
    if (typeof correlationId === 'string' && correlationId.trim()) {
      ids.add(correlationId.trim());
    }
  }
  return [...ids];
}

function summarizeSnapshot(snapshot: Record<string, any>, redact: boolean): string {
  const parts = [
    `mission=${snapshot.mission_id || 'unknown'}`,
    `stage=${snapshot.stage || 'unknown'}`,
    `kind=${snapshot.kind || 'unknown'}`,
    `source=${snapshot.source || 'unknown'}`,
  ];
  if (snapshot.trace_ref) parts.push(`trace_ref=${snapshot.trace_ref}`);
  const goal = snapshot.intent?.goal;
  if (goal) parts.push(redact ? 'goal=[redacted]' : `goal=${compactText(goal)}`);
  return parts.join(' ');
}

function summarizeDelta(delta: Record<string, any>): string {
  const parts = [
    `from=${delta.from_snapshot || 'unknown'}`,
    `to=${delta.to_snapshot || 'unknown'}`,
  ];
  if (delta.drift_verdict) parts.push(`verdict=${delta.drift_verdict}`);
  if (typeof delta.drift_score === 'number') parts.push(`score=${delta.drift_score}`);
  if (delta.notes) parts.push(`notes=${compactText(delta.notes)}`);
  return parts.join(' ');
}

function summarizeMemory(entry: IntentContractMemoryEntry): string {
  const parts = [
    `intent=${entry.intent_id}`,
    `contract=${entry.contract_ref.kind}:${entry.contract_ref.ref}`,
    `shape=${entry.execution_shape}`,
    `samples=${entry.sample_count}`,
    `success_rate=${entry.success_rate}`,
  ];
  if (entry.mission_id) parts.push(`mission=${entry.mission_id}`);
  if (entry.correlation_id) parts.push(`correlation=${entry.correlation_id}`);
  if (entry.last_error) parts.push(`last_error=${compactText(entry.last_error)}`);
  return parts.join(' ');
}

function summarizeTrace(trace: Trace): string {
  const parts = [
    `trace=${trace.traceId}`,
    `root=${trace.rootSpan.name}`,
    `spans=${countSpans(trace.rootSpan)}`,
    `events=${countEvents(trace.rootSpan)}`,
    `status=${renderStatus('progress', trace.rootSpan.status === 'ok' ? 'completed' : 'failed', resolveVocabularyLocale(process.env.LANG))}`,
  ];
  if (trace.metadata.missionId) parts.push(`mission=${trace.metadata.missionId}`);
  if (trace.metadata.correlationId) parts.push(`correlation=${trace.metadata.correlationId}`);
  return parts.join(' ');
}

function countSpans(span: Trace['rootSpan']): number {
  return 1 + span.children.reduce((sum, child) => sum + countSpans(child), 0);
}

function countEvents(span: Trace['rootSpan']): number {
  return span.events.length + span.children.reduce((sum, child) => sum + countEvents(child), 0);
}

function flattenTrace(trace: Trace): IntentTraceRow[] {
  const rows: IntentTraceRow[] = [];
  const walk = (span: Trace['rootSpan'], depth: number): void => {
    rows.push({
      timestamp: normalizeTimestamp(span.startTime),
      source: 'trace',
      label: `${'  '.repeat(depth)}span:start`,
      summary: `${span.name} status=${span.status}${trace.metadata.correlationId ? ` correlation=${trace.metadata.correlationId}` : ''}`,
      refs: [trace.traceId, span.spanId],
    });
    for (const event of span.events) {
      rows.push({
        timestamp: normalizeTimestamp(event.timestamp),
        source: 'trace',
        label: `${'  '.repeat(depth)}event`,
        summary: `${event.name}${event.attributes?.correlationId ? ` correlation=${String(event.attributes.correlationId)}` : ''}`,
        refs: [trace.traceId, span.spanId],
      });
    }
    for (const child of span.children) {
      walk(child, depth + 1);
    }
    if (span.endTime) {
      rows.push({
        timestamp: normalizeTimestamp(span.endTime),
        source: 'trace',
        label: `${'  '.repeat(depth)}span:end`,
        summary: `${span.name} status=${span.status}`,
        refs: [trace.traceId, span.spanId],
      });
    }
  };

  walk(trace.rootSpan, 0);
  return rows;
}

function loadSnapshotEntries(
  missionId: string,
  evidencePath: string | null
): IntentTraceSnapshotHit[] {
  if (!evidencePath) return [];
  const snapshotFile = path.join(evidencePath, 'intent-snapshots.jsonl');
  return safeJsonLines(snapshotFile).map((snapshot) => ({
    missionId,
    filePath: snapshotFile,
    snapshot,
  }));
}

function loadDeltaEntries(missionId: string, evidencePath: string | null): IntentTraceDeltaHit[] {
  if (!evidencePath) return [];
  const deltaFile = path.join(evidencePath, 'intent-deltas.jsonl');
  return safeJsonLines(deltaFile).map((delta) => ({
    missionId,
    filePath: deltaFile,
    delta,
  }));
}

function loadTraceRecords(traceDir: string): IntentTraceTraceHit[] {
  if (!safeExistsSync(traceDir)) return [];
  const traces: IntentTraceTraceHit[] = [];
  for (const entry of safeReaddir(traceDir)) {
    const filePath = path.join(traceDir, entry);
    if (!safeExistsSync(filePath)) continue;
    for (const record of safeJsonLines(filePath)) {
      if (!record || typeof record !== 'object') continue;
      const trace = record as Trace;
      traces.push({ filePath, trace });
    }
  }
  return traces;
}

function resolveTraceSearchDirs(): string[] {
  const dirs = [
    customerResolver.customerRoot('logs/traces') || null,
    pathResolver.shared('logs/traces'),
  ].filter((dir): dir is string => Boolean(dir));
  return Array.from(new Set(dirs));
}

function discoverAccessibleMissionRoots(): Array<{ missionId: string; missionPath: string }> {
  const discovered: Array<{ missionId: string; missionPath: string }> = [];
  const visit = (dir: string): void => {
    if (!safeExistsSync(dir)) return;
    for (const entry of safeReaddir(dir)) {
      const entryPath = path.join(dir, entry);
      const statePath = path.join(entryPath, 'mission-state.json');
      if (safeExistsSync(statePath)) {
        discovered.push({ missionId: entry, missionPath: entryPath });
        continue;
      }
      if (safeExistsSync(entryPath)) {
        const nestedState = path.join(entryPath, 'mission-state.json');
        if (safeExistsSync(nestedState)) {
          discovered.push({ missionId: path.basename(entryPath), missionPath: entryPath });
        }
      }
    }
  };

  for (const missionRoot of [
    pathResolver.active('missions'),
    pathResolver.active('archive/missions'),
  ]) {
    visit(missionRoot);
    for (const tier of ['confidential', 'public', 'personal', 'ephemeral']) {
      visit(path.join(missionRoot, tier));
    }
  }
  return discovered;
}

function discoverMissionRoots(): Array<{ missionId: string; missionPath: string }> {
  try {
    return listMissionsInSearchDirs();
  } catch {
    return discoverAccessibleMissionRoots();
  }
}

function collectMissionHits(
  correlationId: string,
  missionRoots: Array<{ missionId: string; missionPath: string }>,
  loadMissionState: (missionId: string) => MissionState | null
): IntentTraceMissionHit[] {
  return missionRoots
    .map(({ missionId, missionPath }) => {
      const state =
        loadMissionState(missionId) ||
        (() => {
          const statePath = path.join(missionPath, 'mission-state.json');
          if (!safeExistsSync(statePath)) return null;
          try {
            return JSON.parse(
              String(safeReadFile(statePath, { encoding: 'utf8' }))
            ) as MissionState;
          } catch {
            return null;
          }
        })();
      if (!state) return null;
      const correlationIds = extractMissionCorrelationIds(state);
      if (!correlationIds.includes(correlationId)) return null;
      return {
        missionId,
        missionPath,
        state,
        evidencePath: path.join(missionPath, 'evidence'),
        matchedCorrelationId: correlationId,
      };
    })
    .filter((entry): entry is IntentTraceMissionHit => Boolean(entry));
}

export function collectIntentTraceReport(
  correlationId: string,
  options: IntentTraceCollectOptions = {}
): IntentTraceReportData {
  const missionRoots = options.missionRoots || discoverMissionRoots();
  const loadMissionStateFn = options.loadMissionState || loadState;
  const missions = collectMissionHits(correlationId, missionRoots, loadMissionStateFn);
  const snapshots = missions.flatMap((mission) => {
    const entries = loadSnapshotEntries(mission.missionId, mission.evidencePath);
    const hasTraceRefs = entries.some((entry) => typeof entry.snapshot.trace_ref === 'string');
    return hasTraceRefs
      ? entries.filter((entry) => entry.snapshot.trace_ref === correlationId)
      : entries;
  });
  const deltas = missions.flatMap((mission) =>
    loadDeltaEntries(mission.missionId, mission.evidencePath)
  );
  const memoryEntries = (options.loadMemory || loadIntentContractMemorySnapshot)().entries.filter(
    (entry) => entry.correlation_id === correlationId || entry.mission_id === correlationId
  );
  const traces = (options.traceDir ? [options.traceDir] : resolveTraceSearchDirs())
    .flatMap((dir) => loadTraceRecords(dir))
    .filter((entry) => entry.trace.metadata.correlationId === correlationId);
  const auditEntries = (options.loadAuditEntries || (() => auditChain.loadAll()))().filter(
    (entry) => entry.correlationId === correlationId
  );

  return {
    correlationId,
    locale: resolveVocabularyLocale(options.locale || process.env.LANG),
    missions,
    snapshots,
    deltas,
    memoryEntries,
    traces,
    auditEntries,
  };
}

export function buildIntentTraceRows(report: IntentTraceReportData): IntentTraceRow[] {
  const redact = report.missions.some((mission) => shouldRedact(mission.state));
  const rows: IntentTraceRow[] = [];

  for (const mission of report.missions) {
    rows.push({
      timestamp: normalizeTimestamp(mission.state.history.at(-1)?.ts),
      source: 'mission',
      label: 'mission',
      summary: `${summarizeMissionState(mission.state, shouldRedact(mission.state))}${
        mission.state.correlation_id ? '' : ` correlation=${mission.matchedCorrelationId}`
      }`,
      refs: [mission.missionId],
    });
    for (const historyEntry of mission.state.history || []) {
      rows.push({
        timestamp: normalizeTimestamp(historyEntry.ts),
        source: 'mission',
        label: `history:${historyEntry.event}`,
        summary: [
          historyEntry.from ? `from=${historyEntry.from}` : null,
          historyEntry.to ? `to=${historyEntry.to}` : null,
          redact ? 'note=[redacted]' : compactText(historyEntry.note),
        ]
          .filter(Boolean)
          .join(' '),
        refs: [mission.missionId],
      });
    }
  }

  for (const snapshot of report.snapshots) {
    rows.push({
      timestamp: normalizeTimestamp(snapshot.snapshot.created_at),
      source: 'snapshot',
      label: 'snapshot',
      summary: summarizeSnapshot(snapshot.snapshot, redact),
      refs: [snapshot.missionId, path.basename(snapshot.filePath)],
    });
  }

  for (const delta of report.deltas) {
    rows.push({
      timestamp: normalizeTimestamp(delta.delta.computed_at),
      source: 'delta',
      label: 'delta',
      summary: summarizeDelta(delta.delta),
      refs: [delta.missionId, path.basename(delta.filePath)],
    });
  }

  for (const entry of report.memoryEntries) {
    rows.push({
      timestamp: normalizeTimestamp(entry.last_seen),
      source: 'memory',
      label: 'memory',
      summary: summarizeMemory(entry),
      refs: [entry.intent_id],
    });
  }

  for (const traceHit of report.traces) {
    rows.push({
      timestamp: normalizeTimestamp(
        traceHit.trace.metadata.completedAt || traceHit.trace.metadata.startedAt
      ),
      source: 'trace',
      label: 'trace',
      summary: summarizeTrace(traceHit.trace),
      refs: [traceHit.trace.traceId, path.basename(traceHit.filePath)],
    });
    rows.push(...flattenTrace(traceHit.trace));
  }

  for (const auditEntry of report.auditEntries) {
    rows.push({
      timestamp: normalizeTimestamp(auditEntry.timestamp),
      source: 'audit',
      label: `${auditEntry.action}:${auditEntry.operation}`,
      summary: [
        `agent=${auditEntry.agentId}`,
        `result=${auditEntry.result}`,
        auditEntry.reason && !redact ? `reason=${compactText(auditEntry.reason)}` : null,
      ]
        .filter(Boolean)
        .join(' '),
      refs: [auditEntry.id],
    });
  }

  return rows.sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.source.localeCompare(right.source)
  );
}

function padRight(value: string, width: number): string {
  const text = value || '';
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

function formatRows(rows: IntentTraceRow[], maxRows: number): string {
  const visible = rows.slice(0, maxRows);
  const columns = {
    timestamp: Math.max('timestamp'.length, ...visible.map((row) => row.timestamp.length)),
    source: Math.max('source'.length, ...visible.map((row) => row.source.length)),
    label: Math.max('label'.length, ...visible.map((row) => row.label.length)),
  };
  const lines = [
    `${padRight('timestamp', columns.timestamp)}  ${padRight('source', columns.source)}  ${padRight('label', columns.label)}  summary  refs`,
  ];
  for (const row of visible) {
    lines.push(
      `${padRight(row.timestamp, columns.timestamp)}  ${padRight(row.source, columns.source)}  ${padRight(row.label, columns.label)}  ${row.summary}  ${row.refs.map(toSafeRef).filter(Boolean).join(' | ')}`
    );
  }
  if (rows.length > visible.length) {
    lines.push(`... ${rows.length - visible.length} more row(s)`);
  }
  return lines.join('\n');
}

export function renderIntentTraceReport(
  report: IntentTraceReportData,
  options: IntentTraceFormatOptions = {}
): string {
  const rows = buildIntentTraceRows(report);
  const maxRows = options.maxRows ?? 200;
  const header = [
    `correlation_id: ${report.correlationId}`,
    `missions: ${report.missions.length}`,
    `snapshots: ${report.snapshots.length}`,
    `deltas: ${report.deltas.length}`,
    `memory_entries: ${report.memoryEntries.length}`,
    `traces: ${report.traces.length}`,
    `audit_entries: ${report.auditEntries.length}`,
  ];
  return `${header.join('\n')}\n\n${formatRows(rows, maxRows)}`;
}

function printJson(report: IntentTraceReportData): void {
  const sanitized = {
    ...report,
    missions: report.missions.map((mission) => ({
      ...mission,
      missionPath: pathResolver.toRepoRelative(mission.missionPath),
      evidencePath: mission.evidencePath ? pathResolver.toRepoRelative(mission.evidencePath) : null,
    })),
    snapshots: report.snapshots.map((snapshot) => ({
      ...snapshot,
      filePath: pathResolver.toRepoRelative(snapshot.filePath),
    })),
    deltas: report.deltas.map((delta) => ({
      ...delta,
      filePath: pathResolver.toRepoRelative(delta.filePath),
    })),
    traces: report.traces.map((traceHit) => ({
      ...traceHit,
      filePath: pathResolver.toRepoRelative(traceHit.filePath),
    })),
  };
  console.log(JSON.stringify(sanitized, null, 2));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = await createStandardYargs(['node', 'intent', ...argv])
    .command(
      'trace <correlationId>',
      'Render the full intent timeline for a correlation id',
      (yargs) =>
        yargs
          .positional('correlationId', {
            type: 'string',
            describe: 'Correlation id to trace',
          })
          .option('json', {
            type: 'boolean',
            default: false,
            description: 'Emit the collected report as JSON',
          })
          .option('limit', {
            type: 'number',
            default: 200,
            description: 'Maximum number of timeline rows to render',
          })
    )
    .demandCommand(1)
    .strict()
    .parse();

  const command = String(parsed._[0] || '');
  if (command !== 'trace') {
    console.error('Usage: pnpm intent trace <correlation_id> [--json] [--limit <n>]');
    process.exit(1);
    return;
  }

  const correlationId = String(parsed.correlationId || parsed._[1] || '').trim();
  if (!correlationId) {
    console.error('Usage: pnpm intent trace <correlation_id> [--json] [--limit <n>]');
    process.exit(1);
    return;
  }

  const report = collectIntentTraceReport(correlationId);
  if (parsed.json) {
    printJson(report);
    return;
  }

  console.log(renderIntentTraceReport(report, { maxRows: Number(parsed.limit) || 200 }));
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err: any) => {
    console.error(`[intent] ${err?.message || err}`);
    process.exit(1);
  });
}
