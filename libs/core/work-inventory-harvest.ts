/**
 * WI-03: turn Kyberion's own usage logs into demand signals and attach them
 * to work inventory entries (docs/developer/improvement-plans-2026-08/
 * WORK_INVENTORY_PLAN_2026-09-22.ja.md §2.3 ②).
 *
 * Sources are scanned read-only and only aggregate numbers, names, and ids
 * are ever extracted — never trace attribute/event text, pipeline step
 * payloads, or unhandled-intent utterance text. See
 * `WorkObservationMetrics` (work-inventory.ts) for the same "counts only"
 * contract on the entry side.
 *
 * - `collectKyberionDemandSignals` scans:
 *   - `active/shared/logs/traces/traces-YYYY-MM-DD.jsonl` (root spans only)
 *   - `active/shared/runtime/feedback-loop/adhoc-pipeline-runs.json` (via
 *     `loadAdhocRunLedgerAtPath`)
 *   - `active/shared/tmp/unhandled-intent-registry.json` (ids/counts only)
 * - `matchSignalsToEntries` / `attachDemandSignals` connect signals to
 *   existing entries via step bindings or a prior `kyberion_trace`
 *   observation, without ever touching self-reported fields.
 * - `suggestEntriesFromSignals` drafts new entries for frequent signals that
 *   match nothing yet, then re-derives `method` via `applyClassification`
 *   (never assigns method directly — same invariant as WI-02).
 */
import * as path from 'node:path';
import { nowIso } from './foundation/time.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { readJsonLines } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir, safeReadFile } from './secure-io.js';
import { loadAdhocRunLedgerAtPath, type AdhocRunTally } from './promotion-candidates.js';
import {
  applyClassification,
  createWorkInventoryEntry,
  loadWorkInventoryTaxonomy,
  validateWorkInventoryEntry,
  type WorkInventoryEntry,
  type WorkInventoryObservation,
  type WorkInventoryScope,
  type WorkInventoryStep,
  type WorkInventoryStepBinding,
  type WorkInventoryTaxonomy,
  type WorkStage,
  type WorkVerb,
  type WorkObservationOrigin,
} from './work-inventory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DemandSignalKind =
  'pipeline' | 'actuator_op' | 'mission' | 'adhoc_pipeline' | 'unhandled_intent';

/**
 * Who started the work: a system schedule (`pipelines/<id>.json` carries an
 * enabled `schedule`), a human/agent on demand, or not determinable. Scheduled
 * runs are system cadence, not human demand, so suggestions skip them by
 * default (see `suggestEntriesFromSignals`).
 */
export type DemandSignalOrigin = WorkObservationOrigin;

/**
 * A demand signal is an aggregate: how often and how long a piece of work
 * ran, keyed by a stable `signature`. Never carries free text.
 */
export interface DemandSignal {
  signature: string;
  kind: DemandSignalKind;
  count: number;
  first_at: string;
  last_at: string;
  per_week: number;
  median_duration_ms?: number;
  failure_count: number;
  /** Window (in days) the count/per_week were computed over. */
  window_days: number;
  /** Up to 5 trace ids that contributed to this signal; empty for non-trace sources. */
  sample_refs: string[];
  /**
   * Set by `collectKyberionDemandSignals`. Optional so hand-built signals
   * (tests, older callers) stay valid; absent is treated as `unknown`.
   */
  origin?: DemandSignalOrigin;
}

export interface CollectKyberionDemandSignalsOptions {
  rootDir?: string;
  since?: Date;
  until?: Date;
  tenantSlug?: string;
  includeUnscoped?: boolean;
  now?: Date;
}

/**
 * WI-13: trace-scan bookkeeping surfaced alongside `DemandSignal[]` so
 * `pnpm inventory harvest` can report hygiene, not just counts. Both figures
 * are about individual *traces* scanned, not signals: `excluded_test_or_ci`
 * traces never touch any signal at all (see `collectTraceSignals`);
 * `untagged` traces (no `metadata.origin` — pre-WI-13) still count normally,
 * same as before, but are called out so operators can see the legacy-trace
 * fraction shrink as the 28-day window ages past the fix.
 */
export interface DemandSignalHarvestStats {
  excluded_test_or_ci: number;
  untagged: number;
}

const DEFAULT_WINDOW_DAYS = 28;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_SAMPLE_REFS = 5;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function resolveWindow(options: CollectKyberionDemandSignalsOptions): {
  since: Date;
  until: Date;
  windowDays: number;
} {
  const until = options.until ?? options.now ?? new Date();
  const since = options.since ?? new Date(until.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY);
  const rawDays = (until.getTime() - since.getTime()) / MS_PER_DAY;
  const windowDays = rawDays > 0 ? rawDays : DEFAULT_WINDOW_DAYS;
  return { since, until, windowDays };
}

// ---------------------------------------------------------------------------
// Trace source (root spans only)
// ---------------------------------------------------------------------------

interface RootSpanClassification {
  kind: DemandSignalKind;
  signature: string;
}

/**
 * Classifies a *root* span name into a demand-signal family, or returns
 * `undefined` to skip it (bookkeeping spans, or an unrecognized family).
 * Root span name families, per plan §2.3 ②: `pipeline:<id>`,
 * `browser-pipeline:<id>`, `<actuator>:<op>`, `mission_run`,
 * `mission_task_dispatch`, `mission:<...>`, `mission_controller:<...>`.
 */
function classifyRootSpanName(name: string): RootSpanClassification | undefined {
  if (name === 'mission_task_dispatch') return undefined;
  if (name.startsWith('mission:') || name.startsWith('mission_controller:')) return undefined;
  if (name === 'mission_run') return { kind: 'mission', signature: 'mission_run' };
  if (name.startsWith('pipeline:') || name.startsWith('browser-pipeline:')) {
    return { kind: 'pipeline', signature: name };
  }
  if (/^[a-z0-9_]+-actuator:.+$/i.test(name)) {
    return { kind: 'actuator_op', signature: name };
  }
  return undefined;
}

function tenantMatches(
  tenantSlug: string | undefined,
  options: CollectKyberionDemandSignalsOptions
): boolean {
  if (options.tenantSlug) {
    if (tenantSlug === options.tenantSlug) return true;
    return tenantSlug === undefined && options.includeUnscoped === true;
  }
  // No tenant requested: personal scope, never mix another tenant's traces in.
  return tenantSlug === undefined;
}

interface SignalAccumulator {
  kind: DemandSignalKind;
  count: number;
  first_at: string;
  last_at: string;
  durations: number[];
  failure_count: number;
  sample_refs: string[];
}

/** WI-13: the closed `Trace['metadata']['origin']` vocabulary (`TraceOrigin` in `src/trace.ts`). */
const TEST_OR_CI_TRACE_ORIGINS = new Set(['test', 'ci']);

interface TraceSignalScanResult {
  signals: DemandSignal[];
  /** Signatures that saw at least one `metadata.origin: 'scheduled'` trace. */
  scheduledSignatures: Set<string>;
  stats: DemandSignalHarvestStats;
}

function traceFilesInWindow(rootDir: string, since: Date, until: Date): string[] {
  const dir = path.join(rootDir, 'active', 'shared', 'logs', 'traces');
  if (!safeExistsSync(dir)) return [];
  const sinceDay = since.toISOString().slice(0, 10);
  const untilDay = until.toISOString().slice(0, 10);
  return safeReaddir(dir)
    .filter((name) => /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .filter((name) => {
      const day = name.slice('traces-'.length, 'traces-'.length + 10);
      return day >= sinceDay && day <= untilDay;
    })
    .map((name) => path.join(dir, name))
    .sort();
}

function collectTraceSignals(
  rootDir: string,
  since: Date,
  until: Date,
  windowDays: number,
  options: CollectKyberionDemandSignalsOptions
): TraceSignalScanResult {
  const files = traceFilesInWindow(rootDir, since, until);
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const accumulators = new Map<string, SignalAccumulator>();
  const scheduledSignatures = new Set<string>();
  let excludedTestOrCi = 0;
  let untagged = 0;

  for (const file of files) {
    let records: unknown[];
    try {
      records = readJsonLines<unknown>(file, { onMalformed: 'skip' });
    } catch {
      continue; // unreadable file: skip, never abort the whole scan
    }
    for (const record of records) {
      if (!isRecord(record)) continue;

      const rootSpan = record.rootSpan;
      if (!isRecord(rootSpan)) continue;
      const name = asString(rootSpan.name);
      if (!name) continue;
      const classification = classifyRootSpanName(name);
      if (!classification) continue;

      const metadata = isRecord(record.metadata) ? record.metadata : {};
      const tenantSlug = asString(metadata.tenantSlug);
      if (!tenantMatches(tenantSlug, options)) continue;

      const startIso = asString(metadata.startedAt) ?? asString(rootSpan.startTime);
      if (!startIso) continue;
      const startMs = Date.parse(startIso);
      if (!Number.isFinite(startMs) || startMs < sinceMs || startMs >= untilMs) continue;

      // WI-13: never let vitest/CI noise become a demand signal; legacy
      // (untagged) traces still count exactly as before, just tallied.
      const traceOrigin = asString(metadata.origin);
      if (traceOrigin && TEST_OR_CI_TRACE_ORIGINS.has(traceOrigin)) {
        excludedTestOrCi += 1;
        continue;
      }
      if (!traceOrigin) untagged += 1;

      const endIso = asString(metadata.completedAt) ?? asString(rootSpan.endTime);
      let durationMs: number | undefined;
      if (endIso) {
        const endMs = Date.parse(endIso);
        if (Number.isFinite(endMs) && endMs >= startMs) durationMs = endMs - startMs;
      }

      const failed = rootSpan.status === 'error';
      const traceId = asString(record.traceId);

      let acc = accumulators.get(classification.signature);
      if (!acc) {
        acc = {
          kind: classification.kind,
          count: 0,
          first_at: startIso,
          last_at: startIso,
          durations: [],
          failure_count: 0,
          sample_refs: [],
        };
        accumulators.set(classification.signature, acc);
      }
      acc.count += 1;
      if (startIso < acc.first_at) acc.first_at = startIso;
      if (startIso > acc.last_at) acc.last_at = startIso;
      if (durationMs !== undefined) acc.durations.push(durationMs);
      if (failed) acc.failure_count += 1;
      if (
        traceId &&
        acc.sample_refs.length < MAX_SAMPLE_REFS &&
        !acc.sample_refs.includes(traceId)
      ) {
        acc.sample_refs.push(traceId);
      }
      if (traceOrigin === 'scheduled') scheduledSignatures.add(classification.signature);
    }
  }

  const results: DemandSignal[] = [];
  for (const [signature, acc] of accumulators) {
    results.push({
      signature,
      kind: acc.kind,
      count: acc.count,
      first_at: acc.first_at,
      last_at: acc.last_at,
      per_week: acc.count / (windowDays / 7),
      ...(acc.durations.length > 0 ? { median_duration_ms: median(acc.durations) } : {}),
      failure_count: acc.failure_count,
      window_days: windowDays,
      sample_refs: acc.sample_refs,
    });
  }
  return {
    signals: results,
    scheduledSignatures,
    stats: { excluded_test_or_ci: excludedTestOrCi, untagged },
  };
}

// ---------------------------------------------------------------------------
// Ad-hoc pipeline ledger source
// ---------------------------------------------------------------------------

const ADHOC_LEDGER_RELATIVE_PATH = path.join(
  'active',
  'shared',
  'runtime',
  'feedback-loop',
  'adhoc-pipeline-runs.json'
);

function collectAdhocLedgerSignals(
  rootDir: string,
  since: Date,
  until: Date,
  windowDays: number
): DemandSignal[] {
  const filePath = path.join(rootDir, ADHOC_LEDGER_RELATIVE_PATH);
  if (!safeExistsSync(filePath)) return [];
  let tallies: AdhocRunTally[];
  try {
    tallies = loadAdhocRunLedgerAtPath(filePath);
  } catch {
    return [];
  }
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  return tallies.map((tally) => {
    const lastMs = Date.parse(tally.last_at);
    const withinWindow = Number.isFinite(lastMs) && lastMs >= sinceMs && lastMs < untilMs;
    return {
      signature: `adhoc_pipeline:${tally.path}`,
      kind: 'adhoc_pipeline',
      count: tally.count,
      first_at: tally.last_at,
      last_at: tally.last_at,
      per_week: withinWindow ? tally.count / (windowDays / 7) : 0,
      failure_count: 0,
      window_days: windowDays,
      sample_refs: [],
    };
  });
}

// ---------------------------------------------------------------------------
// Unhandled intent registry source (ids/labels + counts only — never text)
// ---------------------------------------------------------------------------

const UNHANDLED_INTENT_REGISTRY_RELATIVE_PATH = path.join(
  'active',
  'shared',
  'tmp',
  'unhandled-intent-registry.json'
);

function collectUnhandledIntentSignals(
  rootDir: string,
  since: Date,
  until: Date,
  windowDays: number
): DemandSignal[] {
  const filePath = path.join(rootDir, UNHANDLED_INTENT_REGISTRY_RELATIVE_PATH);
  if (!safeExistsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(
      String(safeReadFile(filePath, { encoding: 'utf8' })),
      'unhandled intent registry'
    );
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];

  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const results: DemandSignal[] = [];
  for (const rawEntry of parsed.entries) {
    if (!isRecord(rawEntry)) continue;
    // 'unrecognized' misses may have no scored intent id at all — those carry
    // no non-text identifier we could safely harvest, so they are skipped.
    const intentId = asString(rawEntry.intent_id);
    if (!intentId) continue;
    const count = typeof rawEntry.occurrence_count === 'number' ? rawEntry.occurrence_count : 0;
    const firstAt = asString(rawEntry.first_seen) ?? nowIso();
    const lastAt = asString(rawEntry.last_seen) ?? firstAt;
    const lastMs = Date.parse(lastAt);
    const withinWindow = Number.isFinite(lastMs) && lastMs >= sinceMs && lastMs < untilMs;
    results.push({
      signature: `intent:${intentId}`,
      kind: 'unhandled_intent',
      count,
      first_at: firstAt,
      last_at: lastAt,
      per_week: withinWindow ? count / (windowDays / 7) : 0,
      failure_count: 0,
      window_days: windowDays,
      sample_refs: [],
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Origin (scheduled vs on-demand)
// ---------------------------------------------------------------------------

const PIPELINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function pipelineIdFromSignature(signature: string): string | undefined {
  for (const prefix of ['pipeline:', 'browser-pipeline:']) {
    if (signature.startsWith(prefix)) return signature.slice(prefix.length);
  }
  return undefined;
}

/**
 * Reads `pipelines/<id>.json` under `rootDir` and reports `scheduled` when it
 * declares a `schedule` whose `enabled` is not `false`, `on_demand` when the
 * file exists without an active schedule, and `unknown` when there is no such
 * pipeline file (e.g. a `browser-pipeline:<session>` span) or it is unreadable.
 */
function resolvePipelineOrigin(rootDir: string, pipelineId: string): DemandSignalOrigin {
  if (!PIPELINE_ID_PATTERN.test(pipelineId) || pipelineId.includes('..')) return 'unknown';
  const filePath = path.join(rootDir, 'pipelines', `${pipelineId}.json`);
  try {
    if (!safeExistsSync(filePath)) return 'unknown';
    const parsed = parseSafeJsonInput(
      String(safeReadFile(filePath, { encoding: 'utf8' })),
      `pipeline ${pipelineId}`
    );
    if (!isRecord(parsed)) return 'unknown';
    const schedule = parsed.schedule;
    if (isRecord(schedule) && schedule.enabled !== false) return 'scheduled';
    return 'on_demand';
  } catch {
    return 'unknown';
  }
}

/**
 * `scheduledSignatures` are signatures that saw at least one trace tagged
 * `metadata.origin: 'scheduled'` (WI-13, chronos-fired work): they always
 * resolve to `scheduled`, even for `actuator_op`/`mission` kinds that the
 * per-kind lookup below never derives a non-`unknown` origin for.
 */
function assignOrigins(
  signals: DemandSignal[],
  rootDir: string,
  scheduledSignatures: Set<string>
): DemandSignal[] {
  const pipelineOrigins = new Map<string, DemandSignalOrigin>(); // per-call lookup cache
  return signals.map((signal) => {
    let origin: DemandSignalOrigin = 'unknown';
    if (signal.kind === 'adhoc_pipeline' || signal.kind === 'unhandled_intent') {
      origin = 'on_demand';
    } else if (signal.kind === 'pipeline') {
      const pipelineId = pipelineIdFromSignature(signal.signature);
      if (pipelineId) {
        let cached = pipelineOrigins.get(pipelineId);
        if (!cached) {
          cached = resolvePipelineOrigin(rootDir, pipelineId);
          pipelineOrigins.set(pipelineId, cached);
        }
        origin = cached;
      }
    }
    if (scheduledSignatures.has(signal.signature)) origin = 'scheduled';
    return { ...signal, origin };
  });
}

// ---------------------------------------------------------------------------
// Public: collect
// ---------------------------------------------------------------------------

export interface CollectKyberionDemandSignalsResult {
  signals: DemandSignal[];
  /** WI-13: trace-hygiene bookkeeping from the trace source only (see `DemandSignalHarvestStats`). */
  stats: DemandSignalHarvestStats;
}

/**
 * Scans Kyberion's own usage logs (traces, ad-hoc pipeline ledger, unhandled
 * intent registry) and returns aggregate demand signals plus trace-hygiene
 * stats. The ledger and the registry carry no tenant, so — like untagged
 * traces — they are included only for the personal scope (no `tenantSlug`) or
 * with `includeUnscoped`. Never trace attribute/event text, pipeline
 * payloads, or intent utterance text; sorted by `count` descending, then
 * `signature` ascending. Every signal carries an `origin` (`pipeline:<id>` /
 * `browser-pipeline:<id>` → looked up in `pipelines/<id>.json`; any signature
 * with a `metadata.origin: 'scheduled'` trace → `scheduled`; ad-hoc ledger and
 * unhandled intents → `on_demand`; everything else → `unknown`).
 */
export function collectKyberionDemandSignalsWithStats(
  options: CollectKyberionDemandSignalsOptions = {}
): CollectKyberionDemandSignalsResult {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const { since, until, windowDays } = resolveWindow(options);

  const traceResult = collectTraceSignals(rootDir, since, until, windowDays, options);

  const signals: DemandSignal[] = assignOrigins(
    [
      ...traceResult.signals,
      // The ad-hoc ledger and unhandled-intent registry carry no tenant, so
      // they are unscoped sources: same rule as an untagged trace.
      ...(tenantMatches(undefined, options)
        ? [
            ...collectAdhocLedgerSignals(rootDir, since, until, windowDays),
            ...collectUnhandledIntentSignals(rootDir, since, until, windowDays),
          ]
        : []),
    ],
    rootDir,
    traceResult.scheduledSignatures
  );

  signals.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  return { signals, stats: traceResult.stats };
}

/**
 * Convenience wrapper over `collectKyberionDemandSignalsWithStats` for
 * callers that only need the signals (e.g. `matchSignalsToEntries`,
 * `suggestEntriesFromSignals`, and every caller predating WI-13's stats).
 */
export function collectKyberionDemandSignals(
  options: CollectKyberionDemandSignalsOptions = {}
): DemandSignal[] {
  return collectKyberionDemandSignalsWithStats(options).signals;
}

// ---------------------------------------------------------------------------
// Public: match signals to entries
// ---------------------------------------------------------------------------

function normalizePipelineId(pipelineId: string): string {
  const trimmed = pipelineId.trim();
  const base = trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed;
  return base.replace(/\.json$/i, '');
}

/**
 * Maps each entry (by `entry_id`) to the demand signals it already matches:
 * a step binding's `pipeline_id` (accepting a bare id or a `pipelines/<id>.json`
 * path), a step binding's explicit `actuator`+`op`, a step binding's
 * `intent_id`, or an existing `kyberion_trace` observation whose `ref` equals
 * the signature. `inferred` bindings (filled from the verb's first taxonomy
 * candidate) never match: generic actuator traffic is not evidence of an entry.
 */
export function matchSignalsToEntries(
  entries: WorkInventoryEntry[],
  signals: DemandSignal[]
): Map<string, DemandSignal[]> {
  const bySignature = new Map(signals.map((signal) => [signal.signature, signal]));
  const result = new Map<string, DemandSignal[]>();

  for (const entry of entries) {
    const matched = new Set<string>();

    for (const step of entry.steps) {
      const binding = step.binding;
      if (!binding) continue;
      if (binding.pipeline_id) {
        const signature = `pipeline:${normalizePipelineId(binding.pipeline_id)}`;
        if (bySignature.has(signature)) matched.add(signature);
      }
      if (binding.actuator && binding.op && binding.inferred !== true) {
        const signature = `${binding.actuator}:${binding.op}`;
        if (bySignature.has(signature)) matched.add(signature);
      }
      if (binding.intent_id) {
        const signature = `intent:${binding.intent_id}`;
        if (bySignature.has(signature)) matched.add(signature);
      }
    }

    for (const observation of entry.observations ?? []) {
      if (observation.source === 'kyberion_trace' && bySignature.has(observation.ref)) {
        matched.add(observation.ref);
      }
    }

    if (matched.size > 0) {
      result.set(
        entry.entry_id,
        [...matched]
          .map((signature) => bySignature.get(signature))
          .filter((s): s is DemandSignal => Boolean(s))
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: attach signals to an entry (immutable, idempotent upsert)
// ---------------------------------------------------------------------------

function digestForSignal(signal: DemandSignal): string {
  const parts = [
    `${signal.count} runs over last ${signal.window_days}d (~${signal.per_week.toFixed(1)}/wk)`,
  ];
  if (signal.median_duration_ms !== undefined) {
    parts.push(`median ${Math.round(signal.median_duration_ms)}ms`);
  }
  if (signal.failure_count > 0) parts.push(`${signal.failure_count} failures`);
  parts.push(`origin ${signal.origin ?? 'unknown'}`);
  return parts.join(', ');
}

/**
 * Returns a new entry with each signal upserted as a `kyberion_trace`
 * observation keyed by `ref` (signature) — calling this again with the same
 * signature replaces rather than duplicates. Never touches self-reported
 * `frequency` / `effort_minutes_per_run`, or observations from other sources.
 */
export function attachDemandSignals(
  entry: WorkInventoryEntry,
  signals: DemandSignal[],
  now: Date = new Date()
): WorkInventoryEntry {
  if (signals.length === 0) return entry;

  const otherObservations = (entry.observations ?? []).filter((o) => o.source !== 'kyberion_trace');
  const traceObservations = new Map<string, WorkInventoryObservation>(
    (entry.observations ?? [])
      .filter((o) => o.source === 'kyberion_trace')
      .map((o) => [o.ref, o] as const)
  );

  for (const signal of signals) {
    traceObservations.set(signal.signature, {
      source: 'kyberion_trace',
      ref: signal.signature,
      observed_at: signal.last_at,
      digest: digestForSignal(signal),
      origin: signal.origin ?? 'unknown',
      metrics: {
        count: signal.count,
        per_week: signal.per_week,
        ...(signal.median_duration_ms !== undefined
          ? { median_duration_ms: signal.median_duration_ms }
          : {}),
        failure_count: signal.failure_count,
        window_days: signal.window_days,
      },
    });
  }

  return {
    ...entry,
    observations: [...otherObservations, ...traceObservations.values()],
    updated_at: nowIso(now),
  };
}

// ---------------------------------------------------------------------------
// Public: suggest draft entries for frequent, unmatched signals
// ---------------------------------------------------------------------------

export interface SuggestEntriesFromSignalsOptions {
  minCount?: number;
  /** Also draft entries for `scheduled` (system-cadence) signals. Default false. */
  includeScheduled?: boolean;
  scope?: WorkInventoryScope;
  now?: Date;
}

function titleFromSignature(signature: string): string {
  const words = signature.split(/[:_-]+/).filter(Boolean);
  const titled = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return titled || signature;
}

function verbForSignal(signal: DemandSignal, taxonomy: WorkInventoryTaxonomy): WorkVerb {
  if (signal.kind === 'pipeline' || signal.kind === 'adhoc_pipeline') return 'operate';
  if (signal.kind === 'unhandled_intent') return 'receive';
  if (signal.kind === 'actuator_op') {
    const actuator = signal.signature.split(':')[0];
    const found = taxonomy.verbs.find((verb) =>
      verb.candidate_bindings.some((binding) => binding.actuator === actuator)
    );
    return found?.id ?? 'operate';
  }
  return 'operate'; // mission
}

function bindingForSignal(signal: DemandSignal): WorkInventoryStepBinding | undefined {
  switch (signal.kind) {
    case 'pipeline': {
      const id = signal.signature.startsWith('browser-pipeline:')
        ? signal.signature.slice('browser-pipeline:'.length)
        : signal.signature.slice('pipeline:'.length);
      return id ? { pipeline_id: id } : undefined;
    }
    case 'adhoc_pipeline': {
      const id = signal.signature.slice('adhoc_pipeline:'.length);
      return id ? { pipeline_id: id } : undefined;
    }
    case 'actuator_op': {
      const separator = signal.signature.indexOf(':');
      if (separator <= 0) return undefined;
      return {
        actuator: signal.signature.slice(0, separator),
        op: signal.signature.slice(separator + 1),
      };
    }
    case 'unhandled_intent': {
      const id = signal.signature.slice('intent:'.length);
      return id ? { intent_id: id } : undefined;
    }
    case 'mission':
    default:
      return undefined;
  }
}

function buildDraftEntry(
  signal: DemandSignal,
  scope: WorkInventoryScope,
  now: Date,
  taxonomy: WorkInventoryTaxonomy
): WorkInventoryEntry {
  const verb = verbForSignal(signal, taxonomy);
  const stage: WorkStage = taxonomy.verbs.find((v) => v.id === verb)?.default_stage ?? 'act';
  const binding = bindingForSignal(signal);

  const step: WorkInventoryStep = {
    step_id: 'S1',
    stage,
    verb,
    description: `Observed via a Kyberion usage signal for "${signal.signature}".`,
    data_sensitivity: 'internal',
    effects: [],
    method: {
      assigned: 'human',
      source: 'proposal',
      rationale: 'pending automatic classification from a Kyberion demand signal',
    },
    ...(binding ? { binding } : {}),
  };

  const draft = createWorkInventoryEntry(
    {
      title: titleFromSignature(signal.signature),
      scope,
      trigger: {
        kind: 'request',
        description: `Observed ${signal.count} times via Kyberion usage signal "${signal.signature}".`,
      },
      steps: [step],
    },
    now
  );

  const classified = applyClassification(draft, {}, taxonomy);
  const withSignal = attachDemandSignals(classified, [signal], now);
  const check = validateWorkInventoryEntry(withSignal);
  if (!check.valid) {
    throw new Error(
      `work-inventory-harvest: suggested entry for "${signal.signature}" failed validation: ${check.errors.join('; ')}`
    );
  }
  return withSignal;
}

/**
 * Drafts a `WorkInventoryEntry` (status `draft`) for each signal with
 * `count >= minCount` (default 3) that no existing entry already matches
 * (per `matchSignalsToEntries`). `scheduled` signals are system cadence, not
 * human demand, and are skipped unless `includeScheduled` is set. `method` is
 * always re-derived via `applyClassification` — never assigned directly.
 */
export function suggestEntriesFromSignals(
  signals: DemandSignal[],
  entries: WorkInventoryEntry[],
  options: SuggestEntriesFromSignalsOptions = {}
): WorkInventoryEntry[] {
  const minCount = options.minCount ?? 3;
  const scope = options.scope ?? {};
  const now = options.now ?? new Date();
  const taxonomy = loadWorkInventoryTaxonomy();

  const matched = matchSignalsToEntries(entries, signals);
  const matchedSignatures = new Set<string>();
  for (const list of matched.values()) {
    for (const signal of list) matchedSignatures.add(signal.signature);
  }

  return signals
    .filter((signal) => options.includeScheduled === true || signal.origin !== 'scheduled')
    .filter((signal) => signal.count >= minCount && !matchedSignatures.has(signal.signature))
    .map((signal) => buildDraftEntry(signal, scope, now, taxonomy));
}
