import * as path from 'node:path';
import {
  loadIntentContractMemorySnapshot,
  listTaskSessions,
  pathResolver,
  renderStatus,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  selectContractCandidates,
  traceLogDir,
  type IntentContractMemoryEntry,
  type TaskSession,
  loadMissionOrchestrationJournal,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { listMissionsInSearchDirs, loadState } from './refactor/mission-state.js';

type JsonRecord = Record<string, unknown> & { [key: string]: unknown };

interface TraceRecord {
  traceId: string;
  rootSpan?: {
    spanId?: string;
    name?: string;
    startTime?: string;
    endTime?: string;
    status?: string;
    attributes?: Record<string, unknown>;
    events?: Array<{
      name?: string;
      timestamp?: string;
      attributes?: Record<string, unknown>;
    }>;
    artifacts?: Array<{
      type?: string;
      path?: string;
      description?: string;
      timestamp?: string;
    }>;
    knowledgeRefs?: string[];
    children?: TraceRecord['rootSpan'][];
  };
  metadata?: {
    missionId?: string;
    actuator?: string;
    pipelineId?: string;
    startedAt?: string;
    completedAt?: string;
    customerId?: string;
    tenantSlug?: string;
    [key: string]: unknown;
  };
  _persistedAt?: string;
}

interface SnapshotRecord {
  snapshot_id: string;
  mission_id: string;
  stage: string;
  created_at: string;
  source: string;
  intent: {
    goal: string;
    constraints?: string[];
    deliverables?: string[];
    excluded?: string[];
    stakeholders?: string[];
  };
  trace_ref?: string;
}

interface MissionTraceEvidence {
  missionId: string;
  missionPath: string;
  state: ReturnType<typeof loadState>;
  snapshots: SnapshotRecord[];
  traceIds: string[];
}

interface IntentTraceEvidence {
  correlationId: string;
  missionEvidence: MissionTraceEvidence[];
  traces: TraceRecord[];
  journals: ReturnType<typeof loadMissionOrchestrationJournal>;
  audits: TraceAuditEntry[];
  taskSessions: TaskSession[];
  memoryMatches: IntentContractMemoryEntry[];
  candidateContracts: ReturnType<typeof selectContractCandidates>;
  inferredIntentIds: string[];
}

interface TraceAuditEntry {
  timestamp: string;
  operation: string;
  result: string;
  correlationId: string | null;
  intentId: string | null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeId(value: unknown): string | null {
  const text = normalizeText(value);
  return text.length > 0 ? text : null;
}

function listJsonlFiles(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.jsonl'))
    .sort((left, right) => left.localeCompare(right));
}

function readJsonlRecords<T>(filePath: string): T[] {
  if (!safeExistsSync(filePath)) return [];
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function walkTraceSpans(
  span: NonNullable<TraceRecord['rootSpan']> | undefined,
  visit: (span: NonNullable<TraceRecord['rootSpan']>) => void
): void {
  if (!span) return;
  visit(span);
  for (const child of span.children || []) {
    walkTraceSpans(child, visit);
  }
}

function collectIntentIdsFromRecord(record: JsonRecord | undefined): string[] {
  if (!record) return [];
  const candidates = new Set<string>();
  const visitValue = (value: unknown) => {
    const id = normalizeId(value);
    if (id) candidates.add(id);
  };

  visitValue(record.intentId);
  visitValue(record.intent_id);
  visitValue(record.selected_intent_id);
  visitValue(record.correlationId);
  visitValue(record.correlation_id);

  const nested = record.attributes;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    visitValue((nested as JsonRecord).intentId);
    visitValue((nested as JsonRecord).intent_id);
    visitValue((nested as JsonRecord).selected_intent_id);
    visitValue((nested as JsonRecord).correlationId);
    visitValue((nested as JsonRecord).correlation_id);
  }

  return [...candidates];
}

function collectTraceIntentIds(trace: TraceRecord): string[] {
  const intentIds = new Set<string>();
  for (const candidate of collectIntentIdsFromRecord(trace.metadata as JsonRecord | undefined)) {
    intentIds.add(candidate);
  }
  walkTraceSpans(trace.rootSpan, (span) => {
    for (const candidate of collectIntentIdsFromRecord(span.attributes as JsonRecord | undefined)) {
      intentIds.add(candidate);
    }
    for (const event of span.events || []) {
      for (const candidate of collectIntentIdsFromRecord(
        event.attributes as JsonRecord | undefined
      )) {
        intentIds.add(candidate);
      }
    }
  });
  return [...intentIds];
}

function collectTaskSessionIntentIds(session: TaskSession): string[] {
  const intentIds = new Set<string>();
  const payload = session.payload || {};
  for (const key of [
    'intent_id',
    'intentId',
    'selected_intent_id',
    'correlation_id',
    'correlationId',
  ]) {
    const candidate = normalizeId(payload[key]);
    if (candidate) intentIds.add(candidate);
  }
  return [...intentIds];
}

function collectTraceFiles(dir: string): TraceRecord[] {
  const traceFiles = listJsonlFiles(dir);
  const traces: TraceRecord[] = [];
  for (const fileName of traceFiles) {
    traces.push(...readJsonlRecords<TraceRecord>(path.join(dir, fileName)));
  }
  return traces;
}

function collectAuditEntries(
  correlationId: string,
  missionEvidence: MissionTraceEvidence[]
): TraceAuditEntry[] {
  const auditDirs = new Set<string>();
  const globalAuditDir = pathResolver.shared('logs/audit');
  if (safeExistsSync(globalAuditDir)) {
    auditDirs.add(globalAuditDir);
  }
  for (const mission of missionEvidence) {
    const missionAuditDir = path.join(mission.missionPath, 'audit');
    if (safeExistsSync(missionAuditDir)) {
      auditDirs.add(missionAuditDir);
    }
  }

  const entries: TraceAuditEntry[] = [];
  for (const auditDir of auditDirs) {
    for (const fileName of listJsonlFiles(auditDir)) {
      const fileEntries = readJsonlRecords<JsonRecord>(path.join(auditDir, fileName));
      for (const entry of fileEntries) {
        if (entry.action !== 'approval_gate') continue;
        const metadata = entry.metadata as JsonRecord | undefined;
        const entryCorrelationId = normalizeId(metadata?.correlationId);
        const entryIntentId = normalizeId(metadata?.intentId);
        if (entryCorrelationId !== correlationId && entryIntentId !== correlationId) continue;
        entries.push({
          timestamp: normalizeText(entry.timestamp),
          operation: normalizeText(entry.operation),
          result: normalizeText(entry.result),
          correlationId: entryCorrelationId,
          intentId: entryIntentId,
        });
      }
    }
  }

  return entries.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function collectMissionEvidence(
  correlationId: string,
  candidateMissionIds?: Set<string>
): MissionTraceEvidence[] {
  const missions = listMissionsInSearchDirs().filter(({ missionId }) => {
    if (!candidateMissionIds || candidateMissionIds.size === 0) return true;
    return candidateMissionIds.has(missionId);
  });
  return missions
    .map(({ missionId, missionPath }) => {
      const state = loadState(missionId);
      const evidenceDir = path.join(missionPath, 'evidence');
      const snapshotFile = path.join(evidenceDir, 'intent-snapshots.jsonl');
      const snapshots = readJsonlRecords<SnapshotRecord>(snapshotFile).filter((snapshot) => {
        return (
          snapshot.mission_id.toLowerCase() === missionId.toLowerCase() ||
          snapshot.trace_ref === correlationId ||
          snapshot.snapshot_id === correlationId
        );
      });

      const traceIds = new Set<string>();
      if (
        state?.context?.mission_finish_trace_summary &&
        state.context.mission_finish_trace_summary.traceId === correlationId
      ) {
        traceIds.add(state.context.mission_finish_trace_summary.traceId);
      }
      if (state?.context?.mission_finish_trace_persisted_path) {
        traceIds.add(state.context.mission_finish_trace_persisted_path);
      }

      const stateMatches =
        state &&
        (missionId.toLowerCase() === correlationId.toLowerCase() ||
          state.context?.mission_finish_trace_summary?.traceId === correlationId ||
          state.context?.mission_completion_summary?.requested_result?.includes(correlationId) ||
          state.intent?.goal_summary?.includes(correlationId) ||
          state.intent?.success_condition?.includes(correlationId));

      if (!stateMatches && snapshots.length === 0 && traceIds.size === 0) {
        return null;
      }

      return {
        missionId,
        missionPath,
        state,
        snapshots,
        traceIds: [...traceIds],
      };
    })
    .filter((entry): entry is MissionTraceEvidence => Boolean(entry));
}

function collectIntentTraceEvidence(
  correlationId: string,
  opts: { locale?: string; traceDirs?: string[] } = {}
): IntentTraceEvidence {
  const traceDirs = opts.traceDirs || [traceLogDir()];
  const traces = traceDirs.flatMap((dir) => collectTraceFiles(dir));
  const matchingTraces = traces.filter((trace) => {
    if (trace.traceId === correlationId) return true;
    if (trace.metadata?.pipelineId === correlationId) return true;
    return collectTraceIntentIds(trace).includes(correlationId);
  });

  const missionIds = new Set<string>();
  for (const trace of matchingTraces) {
    if (trace.metadata?.missionId) {
      missionIds.add(trace.metadata.missionId);
    }
  }
  const missionEvidence = collectMissionEvidence(correlationId, missionIds);
  for (const entry of missionEvidence) {
    missionIds.add(entry.missionId);
  }

  const journals = missionEvidence.flatMap((entry) =>
    loadMissionOrchestrationJournal(entry.missionId)
  );

  const derivedIntentIds = new Set<string>([correlationId]);
  for (const trace of matchingTraces) {
    for (const id of collectTraceIntentIds(trace)) {
      derivedIntentIds.add(id);
    }
  }

  const sessions = listTaskSessions().filter((session) => {
    const sessionIntentIds = collectTaskSessionIntentIds(session);
    const matches =
      session.session_id === correlationId ||
      sessionIntentIds.some(
        (intentId) => intentId === correlationId || derivedIntentIds.has(intentId)
      );
    if (matches) {
      for (const intentId of sessionIntentIds) {
        derivedIntentIds.add(intentId);
      }
    }
    return matches;
  });

  const memorySnapshot = loadIntentContractMemorySnapshot();
  const memoryMatches = memorySnapshot.entries.filter((entry) =>
    derivedIntentIds.has(entry.intent_id)
  );
  const candidateContracts = [...derivedIntentIds].flatMap((intentId) =>
    selectContractCandidates(intentId, 3)
  );
  const audits = collectAuditEntries(correlationId, missionEvidence);

  return {
    correlationId,
    missionEvidence,
    traces: matchingTraces,
    journals,
    audits,
    taskSessions: sessions,
    memoryMatches,
    candidateContracts,
    inferredIntentIds: [...derivedIntentIds],
  };
}

function formatSection(title: string, lines: string[]): string[] {
  return [title, ...lines.map((line) => `  ${line}`)];
}

function formatTraceReport(evidence: IntentTraceEvidence, locale = 'en'): string {
  const lines: string[] = [];
  lines.push(`Intent trace: ${evidence.correlationId}`);
  lines.push(
    `Inferred intent ids: ${evidence.inferredIntentIds.length ? evidence.inferredIntentIds.join(', ') : '(none)'}`
  );
  lines.push('');

  const missionLines = evidence.missionEvidence.length
    ? evidence.missionEvidence.flatMap((entry) => {
        const stateLabel = entry.state?.status
          ? renderStatus('mission', entry.state.status, locale)
          : 'unknown';
        const isSensitive = entry.state?.tier !== 'public';
        const rows = [`${entry.missionId} [${stateLabel}]`];
        if (isSensitive) {
          rows.push('  path: [redacted]');
          rows.push(`  tier: ${entry.state?.tier || 'unknown'}`);
        } else {
          rows.push(`  path: ${entry.missionPath}`);
          if (entry.state?.intent?.goal_summary) {
            rows.push(`  goal: ${entry.state.intent.goal_summary}`);
          }
          if (entry.state?.intent?.success_condition) {
            rows.push(`  success: ${entry.state.intent.success_condition}`);
          }
        }
        if (entry.snapshots.length > 0) {
          rows.push(
            `  snapshots: ${entry.snapshots
              .map(
                (snapshot) =>
                  `${snapshot.snapshot_id}@${snapshot.stage}(${snapshot.trace_ref || 'no-trace'})`
              )
              .join(', ')}`
          );
        }
        return rows;
      })
    : ['(no matching mission state or snapshot records)'];
  lines.push(...formatSection('Mission evidence', missionLines));
  lines.push('');

  const traceLines = evidence.traces.length
    ? evidence.traces.flatMap((trace) => {
        const summary = {
          spans: countTraceSpans(trace.rootSpan),
          events: countTraceEvents(trace.rootSpan),
          artifacts: countTraceArtifacts(trace.rootSpan),
          errors: countTraceErrors(trace.rootSpan),
        };
        const rows = [
          `${trace.traceId}${trace.metadata?.missionId ? ` (mission ${trace.metadata.missionId})` : ''}`,
          `  started: ${trace.metadata?.startedAt || trace.rootSpan?.startTime || 'unknown'}`,
          `  completed: ${trace.metadata?.completedAt || trace.rootSpan?.endTime || 'unknown'}`,
          `  summary: spans=${summary.spans}, events=${summary.events}, artifacts=${summary.artifacts}, errors=${summary.errors}`,
        ];
        const intentIds = collectTraceIntentIds(trace);
        if (intentIds.length > 0) {
          rows.push(`  intent ids: ${intentIds.join(', ')}`);
        }
        return rows;
      })
    : ['(no matching traces found)'];
  lines.push(...formatSection('Trace log', traceLines));
  lines.push('');

  const auditLines = evidence.audits.length
    ? evidence.audits.map((entry) =>
        `${entry.timestamp} ${entry.operation} ${entry.result} ${entry.correlationId ? `corr=${entry.correlationId}` : ''} ${entry.intentId ? `intent=${entry.intentId}` : ''}`.trim()
      )
    : ['(no matching audit entries found)'];
  lines.push(...formatSection('Approval audit', auditLines));
  lines.push('');

  const journalLines = evidence.journals.length
    ? evidence.journals.map((entry) =>
        `${entry.ts} ${entry.event_type} ${entry.status} ${entry.correlation_id ? `corr=${entry.correlation_id}` : ''}`.trim()
      )
    : ['(no matching orchestration journal entries found)'];
  lines.push(...formatSection('Mission journal', journalLines));
  lines.push('');

  const sessionLines = evidence.taskSessions.length
    ? evidence.taskSessions.map((session) => {
        const intentIds = collectTaskSessionIntentIds(session);
        return [
          `${session.session_id} [${session.status}]`,
          `  surface: ${session.surface}`,
          `  task: ${session.task_type}`,
          `  intent ids: ${intentIds.length ? intentIds.join(', ') : '(none)'}`,
        ].join('\n');
      })
    : ['(no matching task sessions found)'];
  lines.push(...formatSection('Task sessions', sessionLines));
  lines.push('');

  const memoryLines = evidence.memoryMatches.length
    ? evidence.memoryMatches.map((entry) => {
        const candidate = evidence.candidateContracts.find(
          (item) =>
            item.intent_id === entry.intent_id &&
            item.contract_ref.kind === entry.contract_ref.kind &&
            item.contract_ref.ref === entry.contract_ref.ref
        );
        const summary = candidate
          ? `candidate score=${candidate.score.toFixed(2)}`
          : 'no candidate';
        return `${entry.intent_id} -> ${entry.contract_ref.kind}:${entry.contract_ref.ref} (${summary})`;
      })
    : ['(no matching intent-contract-memory entries found)'];
  lines.push(...formatSection('Intent memory', memoryLines));

  return lines.join('\n');
}

function countTraceSpans(span: NonNullable<TraceRecord['rootSpan']> | undefined): number {
  if (!span) return 0;
  return 1 + (span.children || []).reduce((sum, child) => sum + countTraceSpans(child), 0);
}

function countTraceEvents(span: NonNullable<TraceRecord['rootSpan']> | undefined): number {
  if (!span) return 0;
  return (
    (span.events || []).length +
    (span.children || []).reduce((sum, child) => sum + countTraceEvents(child), 0)
  );
}

function countTraceArtifacts(span: NonNullable<TraceRecord['rootSpan']> | undefined): number {
  if (!span) return 0;
  return (
    (span.artifacts || []).length +
    (span.children || []).reduce((sum, child) => sum + countTraceArtifacts(child), 0)
  );
}

function countTraceErrors(span: NonNullable<TraceRecord['rootSpan']> | undefined): number {
  if (!span) return 0;
  const current = span.status === 'error' ? 1 : 0;
  return current + (span.children || []).reduce((sum, child) => sum + countTraceErrors(child), 0);
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('locale', {
      type: 'string',
      description: 'Locale for user-facing status text',
      default: 'en',
    })
    .help()
    .parse();

  const subcommand = normalizeText(argv._[0]);
  const correlationId = normalizeText(argv._[1]);
  if (subcommand !== 'trace' || !correlationId) {
    console.error('Usage: pnpm intent trace <correlation_id> [--locale en|ja]');
    process.exit(1);
  }

  const evidence = collectIntentTraceEvidence(correlationId, {
    locale: normalizeText(argv.locale) || 'en',
  });
  console.log(formatTraceReport(evidence, normalizeText(argv.locale) || 'en'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export {
  collectIntentTraceEvidence,
  formatTraceReport,
  collectTraceIntentIds,
  collectTaskSessionIntentIds,
  collectMissionEvidence,
};
