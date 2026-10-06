import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { logger } from '../core.js';
import { formatDiagnostic } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeReaddir, safeStat } from '../secure-io.js';
import { readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { resolveIdentityContext } from '../authority.js';
import { storagePartitionSegments, type StoragePartition } from '../storage-layout.js';
import { enqueueOperationalLearningSignal } from '../operational-learning.js';
import { persistHints } from './feedback-loop.js';
import type { KnowledgeHint } from './knowledge-index.js';

/**
 * LS-01: one adapter between the runtime logs that each subsystem writes in
 * its own JSONL shape and the improvement loop.
 *
 * Every source contributes a reader that turns its records into structural
 * observations (a cluster key, a title, an evidence ref). The harvester groups
 * them per source and key, and once a cluster recurs it is proposed into the
 * governed organization learning queue (`enqueueOperationalLearningSignal`)
 * and, for tenant-free clusters, persisted as a runtime knowledge hint that
 * the knowledge index re-injects into later work. Nothing is promoted here: a
 * human or a mission still approves the proposal.
 *
 * Scope: a harvest with no active tenant processes platform records (no
 * tenant); a harvest inside a tenant processes only that tenant's records.
 * Each scope keeps its own cursor and cluster state in its own partition
 * (`system/` or `confidential/<tenant>/`), so records of another scope stay
 * unread until a harvest runs in that scope.
 *
 * Privacy: a source with a `hintCategory` must build keys and titles from
 * closed vocabularies only (kinds, categories, op names, error codes — see
 * `closedToken` / `errorCode`), because hints are read by every later run.
 * The built-in sources keep every key closed, hint or not, since many logs
 * carry no tenant tag.
 * Tenant clusters never become hints.
 */

export interface LearningObservation {
  /** Structural cluster key (kind/category/op), never raw user text. */
  key: string;
  /** Human-readable cluster title built from the same structural fields. */
  title: string;
  /** Unique pointer back to the source record (id, file#seq, correlation id). */
  ref: string;
  /** ISO timestamp of the source record. */
  ts: string;
  /** Present when the source record belongs to one tenant. */
  tenantSlug?: string;
}

export interface LearningSignalWindow {
  since: Date;
  until: Date;
}

export interface LearningSignalSource {
  /** Stable source id, e.g. `conversation` or `approval-rejection`. */
  id: string;
  /** What the source records and why its failures are lessons. */
  description: string;
  /** Occurrences of one cluster before it is proposed (then again at 2x, 4x, ...). */
  minOccurrences: number;
  /** Hint category for tenant-free clusters; keys and titles must be closed-vocabulary. */
  hintCategory?: string;
  /** Lesson text for a hint; defaults to a generic recurrence sentence. */
  hintText?: (cluster: LearningCluster) => string;
  /** Read observations whose timestamp falls inside the window. */
  read(window: LearningSignalWindow): LearningObservation[];
}

export interface LearningCluster {
  source: string;
  key: string;
  title: string;
  total: number;
  new_count: number;
  first_seen: string;
  last_seen: string;
  refs: string[];
  tenant_slug?: string;
}

interface ClusterState {
  source: string;
  key: string;
  title: string;
  total: number;
  signaled_total: number;
  first_seen: string;
  last_seen: string;
  refs: string[];
  signaled_at?: string;
}

/**
 * On-disk shape of one scope's state. Record-derived keys (source ids, refs)
 * are stored as array entries, never as object keys: the governed JSON reader
 * rejects a file with a `__proto__` / `constructor` key, which would reset the
 * whole state on every harvest.
 */
interface PersistedScopeState {
  version: 3;
  cursors: Array<[string, string]>;
  clusters: ClusterState[];
  seen: Array<[string, Array<[string, string]>]>;
}

/**
 * In-memory state. Keys come from log records (source ids, cluster keys,
 * refs), so they live in Maps — never as properties of a plain object, where
 * a `__proto__` key would reach Object.prototype.
 */
interface ScopeState {
  cursors: Map<string, string>;
  clusters: Map<string, ClusterState>;
  /** Counted refs a source still reports, per source, with the harvest time they were last reported. */
  seen: Map<string, Map<string, string>>;
}

function pairsOf(value: unknown): Array<[string, string]> {
  return Array.isArray(value)
    ? value.filter(
        (pair): pair is [string, string] =>
          Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      )
    : [];
}

export interface LearningSourceReport {
  source: string;
  window: { since: string; until: string };
  observed: number;
  clusters: number;
  proposed: LearningCluster[];
  signal_ids: string[];
  hints: number;
  skipped_scope: number;
  error?: string;
}

export interface LearningHarvestReport {
  harvested_at: string;
  dry_run: boolean;
  scopes: string[];
  sources: LearningSourceReport[];
  signals: number;
  hints: number;
}

export interface HarvestLearningSignalsOptions {
  sources: LearningSignalSource[];
  now?: Date;
  /** Lookback for a source/scope that has no cursor yet. */
  initialLookbackDays?: number;
  /** Report what would be proposed without writing signals, hints or state. */
  dryRun?: boolean;
  /** Root for the per-scope state files (tests). */
  stateRoot?: string;
}

const STATE_DOMAIN = 'runtime/learning-signals';
const STATE_FILE = 'harvest-state.json';
const DEFAULT_LOOKBACK_DAYS = 7;
const CLUSTER_RETENTION_DAYS = 30;
/** Records appended shortly after a harvest can carry an earlier timestamp; re-read this much. */
const CURSOR_OVERLAP_MS = 10 * 60_000;
const MAX_REFS = 10;
const DAY_MS = 86_400_000;

export function defaultLearningHarvestStateRoot(): string {
  return pathResolver.shared(STATE_DOMAIN);
}

function scopePartition(tenantSlug: string): StoragePartition {
  return tenantSlug
    ? { kind: 'tier', tier: 'confidential', tenant: tenantSlug }
    : { kind: 'system' };
}

/** State file of one scope: `<root>/system/...` or `<root>/confidential/<tenant>/...`. */
export function learningHarvestStatePath(root: string, tenantSlug = ''): string {
  return path.join(root, ...storagePartitionSegments(scopePartition(tenantSlug)), STATE_FILE);
}

function loadScopeState(statePath: string): ScopeState {
  const raw = readJsonIfPresent<PersistedScopeState>(statePath);
  const state: ScopeState = { cursors: new Map(), clusters: new Map(), seen: new Map() };
  if (!raw || raw.version !== 3) return state;
  for (const [id, cursor] of pairsOf(raw.cursors)) state.cursors.set(id, cursor);
  for (const cluster of Array.isArray(raw.clusters) ? raw.clusters : []) {
    if (cluster && typeof cluster.source === 'string' && typeof cluster.key === 'string') {
      state.clusters.set(`${cluster.source}|${cluster.key}`, cluster);
    }
  }
  for (const entry of Array.isArray(raw.seen) ? raw.seen : []) {
    if (Array.isArray(entry) && typeof entry[0] === 'string') {
      state.seen.set(entry[0], new Map(pairsOf(entry[1])));
    }
  }
  return state;
}

function saveScopeState(statePath: string, state: ScopeState): void {
  const dir = path.dirname(statePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const persisted: PersistedScopeState = {
    version: 3,
    cursors: [...state.cursors],
    clusters: [...state.clusters.values()],
    seen: [...state.seen].map(([id, refs]) => [id, [...refs]]),
  };
  writeJson(statePath, persisted);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 10);
}

/** First proposal at `min`, then each time the total doubles since the last one. */
export function shouldProposeCluster(total: number, signaledTotal: number, min: number): boolean {
  if (total < min) return false;
  if (signaledTotal <= 0) return true;
  return total >= signaledTotal * 2;
}

function defaultHintText(cluster: LearningCluster): string {
  return (
    `${cluster.title} recurred ${cluster.total} times between ` +
    `${cluster.first_seen.slice(0, 10)} and ${cluster.last_seen.slice(0, 10)}. ` +
    `Check the known cause before repeating the same step.`
  );
}

function signalSummary(cluster: LearningCluster, source: LearningSignalSource): string {
  return (
    `${source.description} The cluster "${cluster.title}" occurred ${cluster.total} times ` +
    `(${cluster.new_count} new) between ${cluster.first_seen} and ${cluster.last_seen}. ` +
    `Decide whether a runbook, prompt, policy or code change removes the recurrence.`
  );
}

interface ScopeRun {
  tenantSlug: string;
  statePath: string;
  state: ScopeState;
}

/**
 * Read every source, update the per-scope cluster state, and propose the
 * clusters that crossed their recurrence threshold. A failing source is
 * reported and skipped; it never blocks the others and keeps its cursors.
 */
export function harvestLearningSignals(
  options: HarvestLearningSignalsOptions
): LearningHarvestReport {
  const now = options.now || new Date();
  const nowMs = now.getTime();
  const stateRoot = options.stateRoot || defaultLearningHarvestStateRoot();
  const lookbackMs = (options.initialLookbackDays ?? DEFAULT_LOOKBACK_DAYS) * DAY_MS;
  const activeTenant = resolveIdentityContext().tenantSlug?.trim() || '';
  // A run inside a tenant harvests only that tenant; platform records wait for
  // a run with no tenant, so their candidates never land under a tenant.
  const scopes: ScopeRun[] = [activeTenant].map((tenantSlug) => {
    const statePath = learningHarvestStatePath(stateRoot, tenantSlug);
    return { tenantSlug, statePath, state: loadScopeState(statePath) };
  });
  const scopeByTenant = new Map(scopes.map((scope) => [scope.tenantSlug, scope]));
  const reports: LearningSourceReport[] = [];

  for (const source of options.sources) {
    const cursorMs = (scope: ScopeRun): number => {
      const cursor = Date.parse(scope.state.cursors.get(source.id) || '');
      return Number.isFinite(cursor) ? cursor : nowMs - lookbackMs;
    };
    const sinceMs = Math.min(...scopes.map((scope) => cursorMs(scope) - CURSOR_OVERLAP_MS));
    const window = { since: new Date(sinceMs), until: now };
    const report: LearningSourceReport = {
      source: source.id,
      window: { since: window.since.toISOString(), until: now.toISOString() },
      observed: 0,
      clusters: 0,
      proposed: [],
      signal_ids: [],
      hints: 0,
      skipped_scope: 0,
    };
    reports.push(report);

    let observations: LearningObservation[];
    try {
      observations = source.read(window);
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      logger.warn(
        formatDiagnostic({
          component: 'learning-signal-adapter',
          what: `source ${source.id} could not be read`,
          why: report.error,
          next: 'its cursors stay put, so the next harvest retries this window',
        })
      );
      continue;
    }

    const touched = new Map<string, { scope: ScopeRun; id: string; newCount: number }>();
    for (const obs of observations) {
      const ts = Date.parse(obs.ts);
      if (!Number.isFinite(ts) || ts > nowMs) continue;
      const scope = scopeByTenant.get(obs.tenantSlug?.trim() || '');
      if (!scope) {
        report.skipped_scope += 1;
        continue;
      }
      // A ref already counted stays remembered for as long as some harvest
      // keeps reporting it (an ongoing finding, or a record re-read inside the
      // overlap); the value is the harvest time it was last reported.
      let seen = scope.state.seen.get(source.id);
      if (!seen) {
        seen = new Map();
        scope.state.seen.set(source.id, seen);
      }
      if (seen.has(obs.ref)) {
        seen.set(obs.ref, now.toISOString());
        continue;
      }
      if (ts <= cursorMs(scope) - CURSOR_OVERLAP_MS) continue;
      seen.set(obs.ref, now.toISOString());
      report.observed += 1;

      const id = `${source.id}|${obs.key}`;
      const current = scope.state.clusters.get(id);
      const next: ClusterState = current
        ? { ...current }
        : {
            source: source.id,
            key: obs.key,
            title: obs.title,
            total: 0,
            signaled_total: 0,
            first_seen: obs.ts,
            last_seen: obs.ts,
            refs: [],
          };
      next.total += 1;
      if (obs.ts < next.first_seen) next.first_seen = obs.ts;
      if (obs.ts > next.last_seen) next.last_seen = obs.ts;
      next.refs = [...next.refs.filter((ref) => ref !== obs.ref), obs.ref].slice(-MAX_REFS);
      scope.state.clusters.set(id, next);
      const touchKey = `${scope.tenantSlug}|${id}`;
      const entry = touched.get(touchKey) || { scope, id, newCount: 0 };
      entry.newCount += 1;
      touched.set(touchKey, entry);
    }
    report.clusters = touched.size;

    const hints: KnowledgeHint[] = [];
    for (const { scope, id, newCount } of touched.values()) {
      const entry = scope.state.clusters.get(id);
      if (!entry) continue;
      if (!shouldProposeCluster(entry.total, entry.signaled_total, source.minOccurrences)) continue;
      const tenantSlug = scope.tenantSlug || undefined;
      const cluster: LearningCluster = {
        source: source.id,
        key: entry.key,
        title: entry.title,
        total: entry.total,
        new_count: newCount,
        first_seen: entry.first_seen,
        last_seen: entry.last_seen,
        refs: [...entry.refs],
        ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
      };
      report.proposed.push(cluster);
      if (options.dryRun) continue;

      const signalId = enqueueOperationalLearningSignal(
        {
          // The total keeps each re-proposal a separate candidate, so a later
          // one never overwrites a candidate a human already reviewed.
          signalId: `${source.id}-${shortHash(entry.key)}-x${entry.total}`,
          sourceType: 'runtime_signal',
          sourceRef: `learning-signal:${source.id}:${entry.key}`,
          title: `Recurring ${source.id}: ${entry.title}`,
          summary: signalSummary(cluster, source),
          evidenceRefs: cluster.refs,
          targetKind: source.hintCategory ? 'knowledge_hint' : 'sop_candidate',
          ...(tenantSlug ? { tier: 'confidential' as const, tenantSlug } : {}),
          metadata: {
            signal_source: source.id,
            cluster_key: entry.key,
            total: cluster.total,
            new_count: cluster.new_count,
            first_seen: cluster.first_seen,
            last_seen: cluster.last_seen,
          },
        },
        { now }
      );
      if (!signalId) continue;
      report.signal_ids.push(signalId);
      entry.signaled_total = entry.total;
      entry.signaled_at = now.toISOString();

      if (source.hintCategory && !tenantSlug) {
        hints.push({
          topic: `${source.id}:${entry.key}`,
          hint: (source.hintText || defaultHintText)(cluster),
          source: `learning-signal:${source.id}`,
          confidence: 0.6,
          tags: ['learning_signal', source.id],
        });
      }
    }

    if (options.dryRun) continue;
    if (hints.length > 0 && source.hintCategory) {
      try {
        persistHints(hints, source.hintCategory);
        report.hints = hints.length;
      } catch (error) {
        logger.warn(
          formatDiagnostic({
            component: 'learning-signal-adapter',
            what: `hints for ${source.id} were not persisted`,
            why: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }
    for (const scope of scopes) {
      scope.state.cursors.set(source.id, now.toISOString());
      // Drop refs this harvest no longer reported: their records fell behind
      // the overlap, or the ongoing finding ended.
      const seen = scope.state.seen.get(source.id);
      if (!seen) continue;
      const reportedAt = now.toISOString();
      for (const [ref, lastReported] of seen) {
        if (lastReported !== reportedAt) seen.delete(ref);
      }
    }
  }

  if (!options.dryRun) {
    const cutoff = new Date(nowMs - CLUSTER_RETENTION_DAYS * DAY_MS).toISOString();
    for (const scope of scopes) {
      for (const [id, entry] of scope.state.clusters) {
        if (entry.last_seen < cutoff) scope.state.clusters.delete(id);
      }
      saveScopeState(scope.statePath, scope.state);
    }
  }

  return {
    harvested_at: now.toISOString(),
    dry_run: Boolean(options.dryRun),
    scopes: scopes.map((scope) => scope.tenantSlug || 'system'),
    sources: reports,
    signals: reports.reduce((sum, r) => sum + r.signal_ids.length, 0),
    hints: reports.reduce((sum, r) => sum + r.hints, 0),
  };
}

// ---------------------------------------------------------------------------
// Reader helpers shared by the built-in sources
// ---------------------------------------------------------------------------

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every UTC day (YYYY-MM-DD) the window touches, oldest first. */
export function daysInWindow(window: LearningSignalWindow): string[] {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(window.since.getUTCFullYear(), window.since.getUTCMonth(), window.since.getUTCDate())
  );
  while (cursor.getTime() <= window.until.getTime()) {
    days.push(isoDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Every UTC month (YYYY-MM) the window touches, oldest first. */
export function monthsInWindow(window: LearningSignalWindow): string[] {
  return Array.from(new Set(daysInWindow(window).map((day) => day.slice(0, 7))));
}

/** Read one JSONL file, skipping malformed lines; a missing file reads as empty. */
export function readJsonlRecords(filePath: string): Record<string, unknown>[] {
  if (!safeExistsSync(filePath)) return [];
  return readJsonLines<Record<string, unknown>>(filePath, { onMalformed: 'skip' }).filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object'
  );
}

/** Read the files in `dir` whose name contains one of `tokens` (e.g. dates). */
export function readJsonlFilesMatching(dir: string, tokens: string[]): Record<string, unknown>[] {
  if (!safeExistsSync(dir)) return [];
  const files = safeReaddir(dir)
    .filter((name) => name.endsWith('.jsonl') && tokens.some((token) => name.includes(token)))
    .sort();
  return files.flatMap((name) => readJsonlRecords(path.join(dir, name)));
}

export function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** A closed-vocabulary token (op name, kind, category) or `fallback` when the value is free text. */
export function closedToken(value: string, fallback = 'other'): string {
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_:-]{0,47}$/.test(trimmed) ? trimmed : fallback;
}

const ERRNO_CODES = [
  'EACCES',
  'EADDRINUSE',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EISDIR',
  'EMFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'ENOTFOUND',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
];

const ERROR_CODE_PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  // Kyberion's own `[UPPER_SNAKE]` diagnostic codes always carry an underscore.
  [/\[([A-Z][A-Z0-9]*_[A-Z0-9_]{1,46})\]/, (m) => m[1]],
  [new RegExp(`\\b(${ERRNO_CODES.join('|')})\\b`), (m) => m[1]],
  [/\b(?:status|HTTP)\s*:?\s*([1-5]\d\d)\b/i, (m) => `http_${m[1]}`],
  [/^([1-5]\d\d)\b/, (m) => `http_${m[1]}`],
  [/timed?\s*-?out|timeout/i, () => 'timeout'],
  [/rate.?limit|too many requests/i, () => 'rate_limited'],
  [/permission|forbidden|denied|unauthori[sz]ed/i, () => 'denied'],
  [/not found|no such/i, () => 'not_found'],
  [/parse|unexpected token|invalid json/i, () => 'parse_error'],
];

/** Map a free-form error onto a closed code (`ENOENT`, `timeout`, `http_429`, ...) or `error`. */
export function errorCode(message: string): string {
  for (const [pattern, pick] of ERROR_CODE_PATTERNS) {
    const match = message.match(pattern);
    if (match) return pick(match);
  }
  return 'error';
}

/** Files in `dir` modified at or after `since` (for writers that name files by their start day). */
export function filesModifiedSince(dir: string, since: Date, suffix = '.jsonl'): string[] {
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith(suffix))
    .filter((name) => {
      try {
        return safeStat(path.join(dir, name)).mtimeMs >= since.getTime();
      } catch {
        return false;
      }
    })
    .sort();
}
