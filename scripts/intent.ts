import * as path from 'node:path';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
} from './lib/harness.js';
import { auditChain } from '@agent/core/governance/audit-chain';
import * as customerResolver from '@agent/core/customer-resolver';
import { createStandardYargs } from '@agent/core/cli-utils';
import { currentScope } from '@agent/core/scope-context';
import { loadIntentContractMemorySnapshot } from '@agent/core/intent/intent-contract-learning';
import {
  loadIntentDeltasAtPath,
  loadIntentSnapshotsAtPath,
} from '@agent/core/intent/intent-snapshot-store';
import { renderStatus, resolveVocabularyLocale } from '@agent/core/ux-vocabulary';
import { resolveLocale } from '@agent/core/locale';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { getRegisteredEnvText, readJsonLines } from '@agent/core/foundation';
import { withImplicitTraceSubcommand } from './lib/intent-trace-argv.js';
import { pathResolver } from '@agent/core/path-resolver';
import { validateTraceReplay } from '@agent/core/analysis/trace-schema';
import type { AuditEntry } from '@agent/core/governance/audit-chain';
import type { IntentContractMemoryEntry } from '@agent/core/intent/intent-contract-learning';
import type { IntentDelta, IntentSnapshot } from '@agent/core/intent/intent-delta';
import type { Trace } from '@agent/core/trace';
import {
  getActiveMissionSearchDirs,
  listMissionsInSearchDirs,
  loadState,
} from '@agent/core/mission/mission-state';
import { readMissionStateAtPath } from '@agent/core/mission/mission-state-reader';
import { boundTenant, missionTierScanDirs } from '@agent/core/owner-scope';
import { isMissionLookupRefusal, missionPathOrNull } from '@agent/core/mission-lookup';
import { validateReadPermission } from '@agent/core/tier-guard';
import type { MissionState } from '@agent/core/mission/mission-types';

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
  snapshot: IntentSnapshot;
}

interface IntentTraceDeltaHit {
  missionId: string;
  filePath: string;
  delta: IntentDelta;
}

interface IntentTraceTraceHit {
  filePath: string;
  trace: Trace;
}

interface IntentTraceReportData {
  correlationId: string;
  locale: string;
  /**
   * Observation contract: only mission trees this process may read were
   * scanned. An empty result therefore means 'no match in the visible scope',
   * never proof that the correlation id does not exist elsewhere.
   */
  searched_scope: 'visible';
  /**
   * complete        — every scan root was enumerable and every enumerated
   *                   mission state parsed.
   * partial         — one or more scan roots are outside this process's io
   *                   scope (e.g. another tier under tenant binding); the
   *                   visible results are still trustworthy.
   * integrity_error — at least one enumerated mission state failed to parse
   *                   or validate. Corrupt-but-visible data is flagged, never
   *                   silently skipped into 'complete'.
   */
  integrity: 'complete' | 'partial' | 'integrity_error';
  anomalies: {
    /** mission-state.json files inside the visible scope that failed to load. */
    unreadable_states: number;
    /** candidate scan roots skipped because this process may not enumerate them. */
    skipped_scan_roots: number;
  };
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

function safeIntentPath(filePath: string, allowMissingLeaf = false): string | null {
  try {
    return assertSafeRepositoryPath(filePath, { allowMissingLeaf });
  } catch {
    return null;
  }
}

function safeJsonLines(filePath: string): Array<Record<string, unknown>> {
  const safeFilePath = safeIntentPath(filePath);
  if (!safeFilePath || !safeExistsSync(safeFilePath)) return [];
  return readJsonLines<Record<string, unknown>>(safeFilePath, {
    onMalformed: 'skip',
    map(value) {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        hasDangerousJsonKey(value)
      ) {
        throw new Error('intent trace JSONL entry must be a safe object');
      }
      return value as Record<string, unknown>;
    },
  });
}

function hasDangerousJsonKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDangerousJsonKey);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)) ||
    Object.values(record).some(hasDangerousJsonKey)
  );
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
    `status=${renderStatus('mission', state.status, resolveVocabularyLocale(resolveLocale()))}`,
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
    `status=${renderStatus('progress', trace.rootSpan.status === 'ok' ? 'completed' : 'failed', resolveVocabularyLocale(resolveLocale()))}`,
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
  const snapshotFile = safeIntentPath(path.join(evidencePath, 'intent-snapshots.jsonl'));
  if (!snapshotFile) return [];
  return loadIntentSnapshotsAtPath(snapshotFile).map((snapshot) => ({
    missionId,
    filePath: snapshotFile,
    snapshot,
  }));
}

function loadDeltaEntries(missionId: string, evidencePath: string | null): IntentTraceDeltaHit[] {
  if (!evidencePath) return [];
  const deltaFile = safeIntentPath(path.join(evidencePath, 'intent-deltas.jsonl'));
  if (!deltaFile) return [];
  return loadIntentDeltasAtPath(deltaFile).map((delta) => ({
    missionId,
    filePath: deltaFile,
    delta,
  }));
}

function loadTraceRecords(traceDir: string): IntentTraceTraceHit[] {
  const safeTraceDir = safeIntentPath(traceDir);
  if (!safeTraceDir || !safeExistsSync(safeTraceDir)) return [];
  const traces: IntentTraceTraceHit[] = [];
  for (const entry of safeReaddir(safeTraceDir)) {
    const filePath = safeIntentPath(path.join(safeTraceDir, entry));
    if (!filePath || !safeExistsSync(filePath)) continue;
    for (const record of safeJsonLines(filePath)) {
      if (!record || typeof record !== 'object') continue;
      if (validateTraceReplay(record, { strictUnknownSpans: true }).length > 0) continue;
      const trace = record as unknown as Trace;
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

/**
 * Candidate mission scan dirs narrowed to the visible scope BEFORE any
 * enumeration. A tenant-bound process may not enumerate a protected tier
 * root — the tenant list itself is out of its io scope — and a role without
 * a grant may not even lstat `knowledge/personal/missions`. Scanning anyway
 * produced ROLE_VIOLATION warnings that disclosed the denied path, and let
 * invisible missions reach `loadState`, where one OWNER_NOT_VISIBLE killed
 * the whole trace. Roots this process may not enumerate are excluded here —
 * never read-then-failed — and counted, so 'no match' always means 'no match
 * in the visible scope', not 'scanned everything'.
 */
function visibleMissionSearchDirs(): { dirs: string[]; skipped: number } {
  const activeRoot = pathResolver.active('missions');
  const archiveRoot = pathResolver.active('archive/missions');
  const tiers = ['personal', 'confidential', 'public', 'ephemeral'];
  const bound = boundTenant();
  const candidates = new Set<string>([
    ...getActiveMissionSearchDirs(),
    // The unpartitioned roots only help an unbound identity; bound, their
    // readdir would lstat denied tier partitions and warn-leak their paths.
    ...(bound ? [] : [activeRoot, archiveRoot]),
    ...tiers.flatMap((tier) => [path.join(activeRoot, tier), path.join(archiveRoot, tier)]),
  ]);
  const dirs = new Set<string>();
  let skipped = 0;
  for (const candidate of candidates) {
    // missionTierScanDirs narrows a protected tier root to the bound tenant's
    // own partition; other tenants are invisible by policy anyway.
    for (const dir of missionTierScanDirs(candidate)) {
      let allowed = false;
      try {
        allowed = validateReadPermission(dir, 'metadata').allowed;
      } catch {
        allowed = false; // a root whose policy check fails is not enumerated
      }
      if (allowed) dirs.add(dir);
      else skipped += 1;
    }
  }
  return { dirs: [...dirs], skipped };
}

function discoverAccessibleMissionRoots(
  dirs: string[]
): Array<{ missionId: string; missionPath: string }> {
  const discovered: Array<{ missionId: string; missionPath: string }> = [];
  const visit = (dir: string): void => {
    const safeDir = safeIntentPath(dir);
    if (!safeDir) return;
    let entries: string[] = [];
    try {
      if (!safeExistsSync(safeDir)) return;
      entries = safeReaddir(safeDir);
    } catch {
      return; // an unreadable directory is simply not in the visible scope
    }
    for (const entry of entries) {
      const entryPath = safeIntentPath(path.join(safeDir, entry));
      if (!entryPath) continue;
      try {
        const statePath = safeIntentPath(path.join(entryPath, 'mission-state.json'));
        if (statePath && safeExistsSync(statePath)) {
          discovered.push({ missionId: entry, missionPath: entryPath });
        }
      } catch {
        continue; // a denied entry is outside the visible scope, never fatal
      }
    }
  };
  for (const dir of dirs) visit(dir);
  return discovered;
}

function discoverMissionRoots(): {
  roots: Array<{ missionId: string; missionPath: string }>;
  skippedScanRoots: number;
} {
  const { dirs, skipped } = visibleMissionSearchDirs();
  try {
    return { roots: listMissionsInSearchDirs({ directories: dirs }), skippedScanRoots: skipped };
  } catch {
    return { roots: discoverAccessibleMissionRoots(dirs), skippedScanRoots: skipped };
  }
}

type VisibleMissionState =
  { kind: 'state'; state: MissionState } | { kind: 'invisible' } | { kind: 'unreadable' };

/**
 * Load one enumerated mission's state without letting scope or corruption
 * kill the trace:
 * - lookup refusals (OWNER_NOT_VISIBLE / AMBIGUOUS / NOT_FOUND) and read
 *   denials mean the mission is outside the visible scope — it is excluded
 *   from the scan set, and its existence is never reported back;
 * - a corrupt-but-visible state is 'unreadable' so the report flags
 *   integrity instead of silently dropping the mission;
 * - the enumerated-path fallback keeps tests / pre-materialized dirs working,
 *   but a state naming another tenant is still excluded — the direct read is
 *   never a permission escalation.
 */
function resolveVisibleMissionState(
  missionId: string,
  missionPath: string,
  loadMissionState: (missionId: string) => MissionState | null
): VisibleMissionState {
  let state: MissionState | null = null;
  try {
    state = loadMissionState(missionId);
  } catch (error) {
    return { kind: isMissionLookupRefusal(error) ? 'invisible' : 'unreadable' };
  }
  if (state) return { kind: 'state', state };
  const statePath = safeIntentPath(path.join(missionPath, 'mission-state.json'));
  if (!statePath) return { kind: 'unreadable' };
  let exists = false;
  try {
    exists = safeExistsSync(statePath);
  } catch {
    return { kind: 'invisible' };
  }
  if (!exists) {
    // The governed locator resolved a path but no state is readable, or the
    // directory was enumerated without one — flag it, never invent data.
    return {
      kind: missionPathOrNull(pathResolver.findMissionPath, missionId) ? 'unreadable' : 'invisible',
    };
  }
  try {
    const direct = readMissionStateAtPath(statePath);
    if (!missionStateVisibleToProcess(direct)) return { kind: 'invisible' };
    return { kind: 'state', state: direct };
  } catch (error) {
    if (isMissionLookupRefusal(error) || isReadDenied(error)) return { kind: 'invisible' };
    return { kind: 'unreadable' };
  }
}

/** The same tenant boundary the owner-scope locator applies to a loaded state. */
function missionStateVisibleToProcess(state: MissionState): boolean {
  const bound = boundTenant();
  if (!bound) return true;
  const slug = String(state.tenant_slug || '')
    .trim()
    .toLowerCase();
  return !slug || slug === bound;
}

/** A secure-io refusal to read a path — not a data problem, a scope boundary. */
function isReadDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ROLE_VIOLATION|not authorized|access denied|denied to/i.test(message);
}

function collectMissionHits(
  correlationId: string,
  missionRoots: Array<{ missionId: string; missionPath: string }>,
  loadMissionState: (missionId: string) => MissionState | null
): { missions: IntentTraceMissionHit[]; unreadableStates: number } {
  let unreadableStates = 0;
  const missions = missionRoots
    .map(({ missionId, missionPath }) => {
      const safeMissionPath = safeIntentPath(missionPath);
      if (!safeMissionPath) return null;
      const resolved = resolveVisibleMissionState(missionId, safeMissionPath, loadMissionState);
      if (resolved.kind === 'unreadable') unreadableStates += 1;
      if (resolved.kind !== 'state') return null;
      const state = resolved.state;
      const correlationIds = extractMissionCorrelationIds(state);
      if (!correlationIds.includes(correlationId)) return null;
      return {
        missionId,
        missionPath: safeMissionPath,
        state,
        evidencePath: safeIntentPath(path.join(safeMissionPath, 'evidence'), true),
        matchedCorrelationId: correlationId,
      };
    })
    .filter((entry): entry is IntentTraceMissionHit => Boolean(entry));
  return { missions, unreadableStates };
}

export function collectIntentTraceReport(
  correlationId: string,
  options: IntentTraceCollectOptions = {}
): IntentTraceReportData {
  const discovery = options.missionRoots
    ? { roots: options.missionRoots, skippedScanRoots: 0 }
    : discoverMissionRoots();
  const loadMissionStateFn = options.loadMissionState || loadState;
  const { missions, unreadableStates } = collectMissionHits(
    correlationId,
    discovery.roots,
    loadMissionStateFn
  );
  const integrity =
    unreadableStates > 0
      ? 'integrity_error'
      : discovery.skippedScanRoots > 0
        ? 'partial'
        : 'complete';
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
  const memoryEntries = (
    options.loadMemory || (() => loadIntentContractMemorySnapshot(currentScope()))
  )().entries.filter(
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
    locale: resolveVocabularyLocale(options.locale || resolveLocale()),
    searched_scope: 'visible',
    integrity,
    anomalies: {
      unreadable_states: unreadableStates,
      skipped_scan_roots: discovery.skippedScanRoots,
    },
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
    `searched_scope: ${report.searched_scope}`,
    `integrity: ${report.integrity}`,
    `missions: ${report.missions.length}`,
    `snapshots: ${report.snapshots.length}`,
    `deltas: ${report.deltas.length}`,
    `memory_entries: ${report.memoryEntries.length}`,
    `traces: ${report.traces.length}`,
    `audit_entries: ${report.auditEntries.length}`,
  ];
  const notes: string[] = [];
  if (rows.length === 0) {
    notes.push(
      `no records matched in the visible scope (searched_scope: ${report.searched_scope})`
    );
  }
  if (report.anomalies.unreadable_states > 0 || report.anomalies.skipped_scan_roots > 0) {
    const parts: string[] = [];
    if (report.anomalies.unreadable_states > 0)
      parts.push(`${report.anomalies.unreadable_states} mission state(s) failed to load`);
    if (report.anomalies.skipped_scan_roots > 0)
      parts.push(
        `${report.anomalies.skipped_scan_roots} scan root(s) outside this process's read scope`
      );
    notes.push(`integrity note: ${parts.join('; ')}`);
  }
  const tail = notes.length ? `\n\n${notes.join('\n')}` : '';
  return `${header.join('\n')}\n\n${formatRows(rows, maxRows)}${tail}`;
}

function serializeJsonReport(report: IntentTraceReportData): Record<string, unknown> {
  return {
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
}

const INTENT_TRACE_USAGE =
  'Usage: pnpm intent:trace <correlation_id> [--json] [--limit <n>]\n' +
  '  trace takes a correlation id emitted by an earlier run — it is not a natural-language query';

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined,
  json = argv.includes('--json')
): Promise<void> {
  const parsed = await createStandardYargs([
    'node',
    'intent',
    ...withImplicitTraceSubcommand(
      stripSharedScriptFlags(argv),
      getRegisteredEnvText('npm_lifecycle_event')
    ),
  ])
    .command(
      'trace <correlationId>',
      'Render the full intent timeline for a correlation id (ids only — not a natural-language question)',
      (yargs) =>
        yargs
          .positional('correlationId', {
            type: 'string',
            describe:
              'Correlation id to trace, e.g. corr-… or a trace/pipeline id from earlier output',
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
    print(INTENT_TRACE_USAGE);
    throw new ScriptExitError(1, INTENT_TRACE_USAGE);
  }

  const correlationId = String(parsed.correlationId || parsed._[1] || '').trim();
  if (!correlationId) {
    print(INTENT_TRACE_USAGE);
    throw new ScriptExitError(1, INTENT_TRACE_USAGE);
  }
  // A multi-word, natural-language argument can never be a correlation id —
  // refuse it before it becomes an unrelated full-mission scan.
  if (/\s/.test(correlationId)) {
    const message =
      'intent trace takes a correlation id, not a natural-language question — ' +
      'no scan was run | next: pass the correlation id printed by the earlier run (e.g. corr-…)';
    print(message);
    throw new ScriptExitError(1, message, false, undefined, {
      code: 'INVALID_INPUT',
      category: 'invalid_input',
      retryable: true,
      next_action: 'pass a single correlation id (no spaces)',
    });
  }

  const report = collectIntentTraceReport(correlationId);
  if (json) {
    print(serializeJsonReport(report));
  } else {
    print(renderIntentTraceReport(report, { maxRows: Number(parsed.limit) || 200 }));
  }
  // R05 convention: the typed report may exit non-zero — a corrupt-but-visible
  // state is flagged as integrity_error, never reported as a clean empty trace.
  if (report.integrity === 'integrity_error') {
    throw new ScriptExitError(1, '', true, report);
  }
}

const isDirect =
  isDirectScript(import.meta.url, 'intent.ts') || isDirectScript(import.meta.url, 'intent.js');
export const runIntent = defineScript({
  name: 'intent',
  flags: ['json', 'quiet'],
  run: async ({ argv, print, json }) => main(argv, print, json),
});

if (isDirect) void runIntent();
