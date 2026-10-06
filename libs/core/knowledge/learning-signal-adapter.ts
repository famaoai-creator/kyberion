import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { logger } from '../core.js';
import { formatDiagnostic } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeReaddir } from '../secure-io.js';
import { readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { resolveIdentityContext } from '../authority.js';
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
 * Privacy: observations never carry free text from the source record — only
 * kinds, categories, ids and counts. A tenant-scoped observation reaches the
 * learning queue only inside the active tenant scope and never becomes a hint.
 */

export interface LearningObservation {
  /** Structural cluster key (kind/category/op), never raw user text. */
  key: string;
  /** Human-readable cluster title built from the same structural fields. */
  title: string;
  /** Pointer back to the source record (id, file, correlation id). */
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
  /** Hint category for tenant-free clusters; omit to propose signals only. */
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
  title: string;
  total: number;
  signaled_total: number;
  first_seen: string;
  last_seen: string;
  refs: string[];
  tenant_slug?: string;
  signaled_at?: string;
}

interface HarvestState {
  version: 1;
  cursors: Record<string, string>;
  clusters: Record<string, ClusterState>;
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
  sources: LearningSourceReport[];
  signals: number;
  hints: number;
}

export interface HarvestLearningSignalsOptions {
  sources: LearningSignalSource[];
  now?: Date;
  /** Lookback for a source that has no cursor yet. */
  initialLookbackDays?: number;
  /** Report what would be proposed without writing signals, hints or state. */
  dryRun?: boolean;
  statePath?: string;
}

const STATE_LOGICAL_PATH = 'runtime/learning-signals/harvest-state.json';
const DEFAULT_LOOKBACK_DAYS = 7;
const CLUSTER_RETENTION_DAYS = 30;
const MAX_REFS = 10;
const DAY_MS = 86_400_000;

export function defaultLearningHarvestStatePath(): string {
  return pathResolver.shared(STATE_LOGICAL_PATH);
}

function loadState(statePath: string): HarvestState {
  const raw = readJsonIfPresent<HarvestState>(statePath);
  if (!raw || raw.version !== 1) return { version: 1, cursors: {}, clusters: {} };
  return { version: 1, cursors: raw.cursors || {}, clusters: raw.clusters || {} };
}

function saveState(statePath: string, state: HarvestState): void {
  const dir = path.dirname(statePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  writeJson(statePath, state);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 10);
}

function clusterId(source: string, key: string, tenantSlug?: string): string {
  return `${source}|${tenantSlug || ''}|${key}`;
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

/**
 * Read every source, update the per-cluster state, and propose the clusters
 * that crossed their recurrence threshold. A failing source is reported and
 * skipped; it never blocks the others.
 */
export function harvestLearningSignals(
  options: HarvestLearningSignalsOptions
): LearningHarvestReport {
  const now = options.now || new Date();
  const statePath = options.statePath || defaultLearningHarvestStatePath();
  const state = loadState(statePath);
  const lookbackMs = (options.initialLookbackDays ?? DEFAULT_LOOKBACK_DAYS) * DAY_MS;
  const activeTenant = resolveIdentityContext().tenantSlug?.trim() || undefined;
  const reports: LearningSourceReport[] = [];

  for (const source of options.sources) {
    const cursor = state.cursors[source.id];
    const since = cursor ? new Date(cursor) : new Date(now.getTime() - lookbackMs);
    const window = { since, until: now };
    const report: LearningSourceReport = {
      source: source.id,
      window: { since: since.toISOString(), until: now.toISOString() },
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
      observations = source.read(window).filter((obs) => {
        const ts = Date.parse(obs.ts);
        return Number.isFinite(ts) && ts > since.getTime() && ts <= now.getTime();
      });
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      logger.warn(
        formatDiagnostic({
          component: 'learning-signal-adapter',
          what: `source ${source.id} could not be read`,
          why: report.error,
          next: 'the cursor stays put, so the next harvest retries this window',
        })
      );
      continue;
    }

    const newCounts = new Map<string, number>();
    for (const obs of observations) {
      if (obs.tenantSlug && obs.tenantSlug !== activeTenant) {
        report.skipped_scope += 1;
        continue;
      }
      report.observed += 1;
      const id = clusterId(source.id, obs.key, obs.tenantSlug);
      const current = state.clusters[id];
      const next: ClusterState = current
        ? { ...current }
        : {
            title: obs.title,
            total: 0,
            signaled_total: 0,
            first_seen: obs.ts,
            last_seen: obs.ts,
            refs: [],
            ...(obs.tenantSlug ? { tenant_slug: obs.tenantSlug } : {}),
          };
      next.total += 1;
      if (obs.ts < next.first_seen) next.first_seen = obs.ts;
      if (obs.ts > next.last_seen) next.last_seen = obs.ts;
      next.refs = [...next.refs.filter((ref) => ref !== obs.ref), obs.ref].slice(-MAX_REFS);
      state.clusters[id] = next;
      newCounts.set(id, (newCounts.get(id) || 0) + 1);
    }
    report.clusters = newCounts.size;

    const hints: KnowledgeHint[] = [];
    for (const [id, newCount] of newCounts) {
      const entry = state.clusters[id];
      if (!shouldProposeCluster(entry.total, entry.signaled_total, source.minOccurrences)) continue;
      const key = id.slice(id.indexOf('|', id.indexOf('|') + 1) + 1);
      const cluster: LearningCluster = {
        source: source.id,
        key,
        title: entry.title,
        total: entry.total,
        new_count: newCount,
        first_seen: entry.first_seen,
        last_seen: entry.last_seen,
        refs: [...entry.refs],
        ...(entry.tenant_slug ? { tenant_slug: entry.tenant_slug } : {}),
      };
      report.proposed.push(cluster);
      if (options.dryRun) continue;

      const signalId = enqueueOperationalLearningSignal(
        {
          signalId: `${source.id}-${shortHash(key)}`,
          sourceType: 'runtime_signal',
          sourceRef: `learning-signal:${source.id}:${key}`,
          title: `Recurring ${source.id}: ${entry.title}`,
          summary: signalSummary(cluster, source),
          evidenceRefs: cluster.refs,
          targetKind: source.hintCategory ? 'knowledge_hint' : 'sop_candidate',
          ...(entry.tenant_slug
            ? { tier: 'confidential' as const, tenantSlug: entry.tenant_slug }
            : {}),
          metadata: {
            signal_source: source.id,
            cluster_key: key,
            total: cluster.total,
            new_count: cluster.new_count,
            first_seen: cluster.first_seen,
            last_seen: cluster.last_seen,
          },
        },
        { now }
      );
      if (signalId) report.signal_ids.push(signalId);
      entry.signaled_total = entry.total;
      entry.signaled_at = now.toISOString();

      if (source.hintCategory && !entry.tenant_slug) {
        hints.push({
          topic: `${source.id}:${key}`,
          hint: (source.hintText || defaultHintText)(cluster),
          source: `learning-signal:${source.id}`,
          confidence: 0.6,
          tags: ['learning_signal', source.id],
        });
      }
    }

    if (!options.dryRun) {
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
      state.cursors[source.id] = now.toISOString();
    }
  }

  if (!options.dryRun) {
    const cutoff = new Date(now.getTime() - CLUSTER_RETENTION_DAYS * DAY_MS).toISOString();
    for (const [id, entry] of Object.entries(state.clusters)) {
      if (entry.last_seen < cutoff) delete state.clusters[id];
    }
    saveState(statePath, state);
  }

  return {
    harvested_at: now.toISOString(),
    dry_run: Boolean(options.dryRun),
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

/** Collapse a free-form error into a structural class: digits, ids and paths removed. */
export function errorClass(message: string, max = 60): string {
  const normalized = message
    .split(/\n|; /)[0]
    .replace(/\[([A-Z0-9_]+)\]/, '$1 ')
    .replace(/(^|[\s'"(=])(?:[A-Za-z]:)?[\\/][^\s'"]+/g, '$1<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'unknown').slice(0, max);
}
