/**
 * Dot outcome evaluation (DL-04) — did a completed action move its KR/signal?
 *
 * `scheduleDotOutcomeChecks` queues every new `done` work result with
 * `due_at = completed_at + settle` (the expected KR's `settle_minutes`, else
 * `goal.outcome_settle_minutes`, else 60). `evaluateDueDotOutcomes` re-measures
 * after the window and appends a direction-aware verdict to `outcomes.jsonl`.
 * `before` is the executor's claim-time `kr_snapshot` / `signal_snapshot` (no
 * pre-action snapshot → unmeasurable); without an `expected_effect` every KR is
 * compared and the largest |Δ| decides. `after` must be measured after the
 * action completed and at or after `due_at`: an unsettled, stale or failed re-measure keeps the check pending and is
 * retried each sweep until {@link DOT_OUTCOME_MAX_WAIT_MS} past due, then it is
 * recorded unmeasurable. Read-only `delegated` results (advice, no effect) are
 * never scheduled.
 *
 * Import-cycle note: registry → this module → dot-executor → dot-runtime →
 * registry, so sections are hoisted functions (like the executor's) and
 * dot-runtime is never imported at all.
 */

import * as path from 'node:path';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { getWorkItem } from '../workforce/work-coordination.js';
import type { KeyResultSpec } from '../key-result-spec.js';
import type { DotCharter } from './dot-charter.js';
import type {
  DotDigestSection,
  DotExtCtx,
  DotPromptSection,
  DotStatusSection,
} from './dot-extensions.js';
import { readDotSignals } from './dot-feedback.js';
import { measureDotKeyResults, readLatestDotKeyResults } from './dot-key-results.js';
import type { DotExpectedEffect } from './dot-proposals.js';
import {
  DOT_OUTCOME_PENDING_FILE,
  DOT_OUTCOMES_FILE,
  DOT_WORK_RESULTS_FILE,
  dotStatePath,
  type DotOutcomeRow,
  type DotWorkResultRow,
} from './dot-state-paths.js';

const logger = createLogger('dot-outcomes');

export const DOT_OUTCOME_DEFAULT_SETTLE_MINUTES = 60;
export const DOT_OUTCOME_PROMPT_LIMIT = 5;
/** How long past due a check waits for a fresh "after" before it is unmeasurable. */
export const DOT_OUTCOME_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const MIN_TOLERANCE = 1e-9;

export type DotOutcomeVerdict = DotOutcomeRow['verdict'];

/** A queued check; `outcomes.jsonl` having the action_ref closes it. */
export interface DotOutcomePendingRow {
  dot_id: string;
  action_ref: string;
  work_item_id: string;
  completed_at: string;
  due_at: string;
  scheduled_at: string;
  expected_effect?: DotExpectedEffect;
  kr_snapshot?: Record<string, number>;
  /** Signal health (1/0) from the executor's claim-time snapshot, the "before" of a signal effect. */
  signal_before?: number;
}

export interface DotOutcomeDeps {
  rootDir?: string;
  now?: () => Date;
  /** Completed work results; defaults to the dot's `work-results.jsonl`. */
  readResults?: (c: DotCharter) => DotWorkResultRow[];
  /** The expected effect the dot declared for a work item; defaults to WorkItem metadata. */
  expectedEffectOf?: (workItemId: string) => DotExpectedEffect | undefined;
  /**
   * Current KR values by kr_id (treated as measured now); defaults to measuring
   * due KRs then reading the latest ledger values with their measured_at.
   */
  measureKrs?: (c: DotCharter) => Promise<Record<string, number>>;
  /** Current health of a signal as 1 (healthy) / 0 (treated as measured now); undefined when unknown. */
  measureSignal?: (c: DotCharter, signal: string) => number | undefined;
  /** Feedback sink for regressed verdicts; defaults to execution feedback. */
  recordRegression?: (c: DotCharter, row: DotOutcomeRow) => Promise<void> | void;
}

function nowOf(deps: { now?: () => Date }): Date {
  return deps.now?.() ?? new Date();
}

function file(deps: { rootDir?: string }, c: DotCharter, name: string): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), dotStatePath(c, name));
}

function readRows<T extends { dot_id: string }>(c: DotCharter, f: string): T[] {
  return readJsonLines<T>(f, { onMalformed: 'skip' }).filter(
    (row) => row && row.dot_id === c.dot_id
  );
}

function appendRow(f: string, row: unknown): void {
  safeMkdir(path.dirname(f), { recursive: true });
  appendJsonLine(f, row);
}

function diag(what: string, why: unknown, next: string, evidence: string): string {
  return `${what} — ${why instanceof Error ? why.message : String(why)} | next: ${next} | evidence: ${evidence}`;
}

function defaultExpectedEffect(
  deps: DotOutcomeDeps
): (id: string) => DotExpectedEffect | undefined {
  return (id) => {
    try {
      const effect = getWorkItem(id, deps.rootDir ? { rootDir: deps.rootDir } : {})?.metadata
        ?.expected_effect as DotExpectedEffect | undefined;
      return effect && typeof effect === 'object' ? effect : undefined;
    } catch {
      return undefined;
    }
  };
}

function settleMinutes(c: DotCharter, effect: DotExpectedEffect | undefined): number {
  const spec = effect?.kr_id ? krSpec(c, effect.kr_id) : undefined;
  const value =
    spec?.settle_minutes ?? c.goal.outcome_settle_minutes ?? DOT_OUTCOME_DEFAULT_SETTLE_MINUTES;
  return Number.isFinite(value) && value >= 0 ? value : DOT_OUTCOME_DEFAULT_SETTLE_MINUTES;
}

function krSpec(c: DotCharter, krId: string): KeyResultSpec | undefined {
  return (c.goal.key_results ?? []).find((spec) => spec.kr_id === krId);
}

/** A re-measured value and when it was measured. */
interface Reading {
  value: number;
  at: string;
}

function signalReading(
  c: DotCharter,
  signal: string,
  deps: DotOutcomeDeps,
  now: Date
): Reading | undefined {
  if (deps.measureSignal) {
    const value = deps.measureSignal(c, signal);
    return value === undefined ? undefined : { value, at: now.toISOString() };
  }
  const rows = readDotSignals(c.dot_id, { rootDir: deps.rootDir }).filter(
    (row) => row.signal === signal
  );
  const last = rows.sort((a, b) => (a.measured_at < b.measured_at ? -1 : 1)).at(-1);
  return last ? { value: last.healthy ? 1 : 0, at: last.measured_at } : undefined;
}

/** Queue outcome checks for `done` work results not yet pending (dedupe by action_ref). */
export function scheduleDotOutcomeChecks(
  c: DotCharter,
  deps: DotOutcomeDeps = {}
): DotOutcomePendingRow[] {
  const pendingFile = file(deps, c, DOT_OUTCOME_PENDING_FILE);
  const known = new Set(readRows<DotOutcomePendingRow>(c, pendingFile).map((r) => r.action_ref));
  for (const row of readRows<DotOutcomeRow>(c, file(deps, c, DOT_OUTCOMES_FILE))) {
    known.add(row.action_ref);
  }
  const results = deps.readResults
    ? deps.readResults(c)
    : readRows<DotWorkResultRow>(c, file(deps, c, DOT_WORK_RESULTS_FILE));
  const effectOf = deps.expectedEffectOf ?? defaultExpectedEffect(deps);
  const scheduled: DotOutcomePendingRow[] = [];
  for (const result of results) {
    if (result.status !== 'done' || !result.action_ref || known.has(result.action_ref)) continue;
    // A delegated turn is read-only advice: it cannot have moved anything.
    if (result.mode === 'delegated') continue;
    const completed = Date.parse(result.completed_at);
    if (!Number.isFinite(completed)) continue;
    const effect = effectOf(result.work_item_id);
    const pending: DotOutcomePendingRow = {
      dot_id: c.dot_id,
      action_ref: result.action_ref,
      work_item_id: result.work_item_id,
      completed_at: result.completed_at,
      due_at: new Date(completed + settleMinutes(c, effect) * 60_000).toISOString(),
      scheduled_at: nowOf(deps).toISOString(),
      ...(effect ? { expected_effect: effect } : {}),
      ...(result.kr_snapshot ? { kr_snapshot: result.kr_snapshot } : {}),
    };
    // The "before" is the claim-time snapshot; measuring now would see the
    // action's own effect. No snapshot -> unmeasurable.
    const before =
      effect?.signal && !effect.kr_id ? result.signal_snapshot?.[effect.signal] : undefined;
    if (before !== undefined) pending.signal_before = before;
    appendRow(pendingFile, pending);
    known.add(result.action_ref);
    scheduled.push(pending);
  }
  return scheduled;
}

function tolerance(spec: KeyResultSpec | undefined): number {
  return Math.max(Math.abs(spec?.target ?? 0) * 0.01, MIN_TOLERANCE);
}

/** Direction-aware verdict for one before/after pair. */
export function dotOutcomeVerdict(
  direction: 'increase' | 'decrease' | 'maintain',
  before: number,
  after: number,
  target: number | undefined,
  tol: number
): DotOutcomeVerdict {
  if (![before, after].every(Number.isFinite)) return 'unmeasurable';
  let gain: number;
  if (direction === 'maintain') {
    const t = target ?? before;
    gain = Math.abs(before - t) - Math.abs(after - t);
  } else {
    gain = direction === 'increase' ? after - before : before - after;
  }
  if (gain > tol) return 'improved';
  if (gain < -tol) return 'regressed';
  return 'no_change';
}

interface Judged {
  ref: DotOutcomeRow['ref'];
  before?: number;
  after?: number;
  verdict: DotOutcomeVerdict;
}

/** `retry`: no fresh "after" yet (stale or failed re-measure) — keep the check pending. */
type Judgement = Judged | { retry: string };

type KrReadings = Record<string, Reading>;

/** "After" evidence must be post-action and cover the full settlement window. */
function fresh(reading: Reading | undefined, pending: DotOutcomePendingRow): reading is Reading {
  if (!reading) return false;
  const measuredAt = Date.parse(reading.at);
  return measuredAt > Date.parse(pending.completed_at) && measuredAt >= Date.parse(pending.due_at);
}

async function judge(
  c: DotCharter,
  pending: DotOutcomePendingRow,
  deps: DotOutcomeDeps,
  krNow: () => Promise<KrReadings | undefined>,
  now: Date
): Promise<Judgement> {
  const effect = pending.expected_effect;
  if (effect?.kr_id) {
    const ref = { kr_id: effect.kr_id };
    const spec = krSpec(c, effect.kr_id);
    const before = pending.kr_snapshot?.[effect.kr_id];
    if (before === undefined) return { ref, verdict: 'unmeasurable' };
    const readings = await krNow();
    if (!readings) return { retry: 'KR re-measure failed' };
    const after = readings[effect.kr_id];
    if (!fresh(after, pending)) return { retry: `no ${effect.kr_id} measurement after settlement` };
    const direction = effect.direction ?? spec?.direction ?? 'increase';
    return {
      ref,
      before,
      after: after.value,
      verdict: dotOutcomeVerdict(direction, before, after.value, spec?.target, tolerance(spec)),
    };
  }
  if (effect?.signal) {
    const ref = { signal: effect.signal };
    const before = pending.signal_before;
    if (before === undefined) return { ref, verdict: 'unmeasurable' };
    const after = signalReading(c, effect.signal, deps, now);
    if (!fresh(after, pending))
      return { retry: `no ${effect.signal} measurement after settlement` };
    return {
      ref,
      before,
      after: after.value,
      verdict: dotOutcomeVerdict(effect.direction, before, after.value, 1, 0.5),
    };
  }
  // No declared effect: the KR with the largest |Δ| speaks for the action.
  const candidates = (c.goal.key_results ?? []).filter(
    (spec) => pending.kr_snapshot?.[spec.kr_id] !== undefined
  );
  if (candidates.length === 0) return { ref: {}, verdict: 'unmeasurable' };
  const readings = await krNow();
  if (!readings) return { retry: 'KR re-measure failed' };
  let best: { id: string; before: number; after: number } | undefined;
  for (const spec of candidates) {
    const before = pending.kr_snapshot![spec.kr_id];
    const after = readings[spec.kr_id];
    if (!fresh(after, pending)) continue;
    if (!best || Math.abs(after.value - before) > Math.abs(best.after - best.before)) {
      best = { id: spec.kr_id, before, after: after.value };
    }
  }
  if (!best) return { retry: 'no KR measurement after settlement' };
  const spec = krSpec(c, best.id);
  return {
    ref: { kr_id: best.id },
    before: best.before,
    after: best.after,
    verdict: dotOutcomeVerdict(
      spec?.direction ?? 'increase',
      best.before,
      best.after,
      spec?.target,
      tolerance(spec)
    ),
  };
}

async function measureKrReadings(
  c: DotCharter,
  deps: DotOutcomeDeps,
  now: Date
): Promise<KrReadings> {
  const out: KrReadings = {};
  if (deps.measureKrs) {
    for (const [id, value] of Object.entries(await deps.measureKrs(c)))
      out[id] = { value, at: now.toISOString() };
    return out;
  }
  await measureDotKeyResults(c, { rootDir: deps.rootDir, now: deps.now });
  for (const [id, row] of readLatestDotKeyResults(c, { rootDir: deps.rootDir }))
    out[id] = { value: row.value, at: row.measured_at };
  return out;
}

async function defaultRecordRegression(c: DotCharter, row: DotOutcomeRow): Promise<void> {
  const { recordExecutionFeedback } = await import('../execution-feedback.js');
  const tenant = Boolean(c.scope.tenant_slug);
  const subject = row.ref.kr_id ?? row.ref.signal ?? 'unknown';
  // Tenant dots: ids and numbers only; no prose into the global store.
  recordExecutionFeedback({
    scenario_id: `dot-outcome:${c.dot_id}`,
    intent_id: row.action_ref,
    surface: 'dot',
    outcome: 'dissatisfied',
    comment: tenant
      ? `Action ${row.action_ref} regressed an outcome.`
      : `Action ${row.action_ref} regressed ${subject} (${row.before} -> ${row.after}).`,
    source: 'operator',
  });
}

/** Evaluate every due pending check that has no verdict yet; returns the new rows. */
export async function evaluateDueDotOutcomes(
  c: DotCharter,
  deps: DotOutcomeDeps = {}
): Promise<DotOutcomeRow[]> {
  const now = nowOf(deps);
  const outFile = file(deps, c, DOT_OUTCOMES_FILE);
  const done = new Set(readRows<DotOutcomeRow>(c, outFile).map((r) => r.action_ref));
  const due = readRows<DotOutcomePendingRow>(c, file(deps, c, DOT_OUTCOME_PENDING_FILE)).filter(
    (row) => !done.has(row.action_ref) && Date.parse(row.due_at) <= now.getTime()
  );
  if (due.length === 0) return [];
  let cached: Promise<KrReadings | undefined> | undefined;
  const krNow = () =>
    (cached ??= measureKrReadings(c, deps, now).catch((error) => {
      logger.warn(
        diag(
          `KR re-measure failed for ${c.dot_id}`,
          error,
          'checks stay pending and retry next sweep',
          DOT_OUTCOMES_FILE
        )
      );
      return undefined;
    }));
  const rows: DotOutcomeRow[] = [];
  for (const pending of due) {
    const expired = now.getTime() > Date.parse(pending.due_at) + DOT_OUTCOME_MAX_WAIT_MS;
    let judged: Judged;
    try {
      const judgement = await judge(c, pending, deps, krNow, now);
      if ('retry' in judgement) {
        if (!expired) continue; // retried next sweep
        judged = {
          ref: pending.expected_effect?.kr_id
            ? { kr_id: pending.expected_effect.kr_id }
            : pending.expected_effect?.signal
              ? { signal: pending.expected_effect.signal }
              : {},
          verdict: 'unmeasurable',
        };
      } else {
        judged = judgement;
      }
    } catch (error) {
      if (!expired) {
        logger.warn(
          diag(
            `outcome judge failed for ${pending.action_ref}`,
            error,
            'retried next sweep',
            DOT_OUTCOMES_FILE
          )
        );
        continue;
      }
      judged = { ref: {}, verdict: 'unmeasurable' };
    }
    const row: DotOutcomeRow = {
      dot_id: c.dot_id,
      action_ref: pending.action_ref,
      work_item_id: pending.work_item_id,
      ref: judged.ref,
      ...(judged.before !== undefined ? { before: judged.before } : {}),
      ...(judged.after !== undefined ? { after: judged.after } : {}),
      verdict: judged.verdict,
      due_at: pending.due_at,
      measured_at: now.toISOString(),
    };
    appendRow(outFile, row);
    rows.push(row);
    if (row.verdict === 'regressed') {
      try {
        await (deps.recordRegression ?? defaultRecordRegression)(c, row);
      } catch (error) {
        logger.warn(
          diag(
            `regression feedback failed for ${row.action_ref}`,
            error,
            'verdict is kept',
            DOT_OUTCOMES_FILE
          )
        );
      }
    }
  }
  return rows;
}

export function readDotOutcomes(
  c: DotCharter,
  opts: { limit?: number; rootDir?: string } = {}
): DotOutcomeRow[] {
  const rows = readRows<DotOutcomeRow>(c, file(opts, c, DOT_OUTCOMES_FILE));
  return opts.limit !== undefined ? rows.slice(-opts.limit) : rows;
}

export interface DotOutcomeStats {
  improved: number;
  no_change: number;
  regressed: number;
  unmeasurable: number;
  /** improved / (improved + no_change + regressed); 0 when nothing was measurable. */
  success_rate: number;
}

export function dotOutcomeStats(
  c: DotCharter,
  opts: { sinceDays?: number; rootDir?: string; now?: () => Date } = {}
): DotOutcomeStats {
  const cutoff =
    opts.sinceDays !== undefined ? nowOf(opts).getTime() - opts.sinceDays * 86_400_000 : -Infinity;
  const stats: DotOutcomeStats = {
    improved: 0,
    no_change: 0,
    regressed: 0,
    unmeasurable: 0,
    success_rate: 0,
  };
  for (const row of readDotOutcomes(c, { rootDir: opts.rootDir })) {
    if (Date.parse(row.measured_at) < cutoff) continue;
    stats[row.verdict] += 1;
  }
  const judged = stats.improved + stats.no_change + stats.regressed;
  stats.success_rate = judged === 0 ? 0 : stats.improved / judged;
  return stats;
}

function describe(row: DotOutcomeRow): string {
  const subject = row.ref.kr_id ?? row.ref.signal ?? 'n/a';
  const delta =
    row.before !== undefined && row.after !== undefined ? ` (${row.before} -> ${row.after})` : '';
  return `${row.action_ref} on ${subject}: ${row.verdict}${delta}`;
}

export function dotOutcomesPromptLines(c: DotCharter, ctx: DotExtCtx): string[] {
  const rows = readDotOutcomes(c, { limit: DOT_OUTCOME_PROMPT_LIMIT, rootDir: ctx.rootDir });
  if (rows.length === 0) return [];
  return [
    'Outcomes of your finished actions (did they move the needle? learn from regressions):',
    ...rows.map((row) => `- ${describe(row)}`),
  ];
}

/** Hoisted factories: registry registers them mid-cycle (see module header). */
export function dotOutcomesPromptSection(): DotPromptSection {
  return { id: 'dot-outcomes', order: 45, lines: (c, ctx) => dotOutcomesPromptLines(c, ctx) };
}

export function dotOutcomesDigestSection(): DotDigestSection {
  return {
    id: 'dot-outcomes',
    lines(c, since, ctx) {
      const rows = readDotOutcomes(c, { rootDir: ctx.rootDir }).filter(
        (row) => !since || Date.parse(row.measured_at) >= since.getTime()
      );
      if (rows.length === 0) return [];
      return [
        'Action outcomes:',
        ...rows.slice(-DOT_OUTCOME_PROMPT_LIMIT).map((row) => `- ${describe(row)}`),
      ];
    },
  };
}

export function dotOutcomesStatusSection(): DotStatusSection {
  return {
    id: 'outcomes',
    collect(c, ctx) {
      return {
        outcomes: {
          stats_30d: dotOutcomeStats(c, { sinceDays: 30, rootDir: ctx.rootDir, now: ctx.now }),
          recent: readDotOutcomes(c, { limit: DOT_OUTCOME_PROMPT_LIMIT, rootDir: ctx.rootDir }),
        },
      };
    },
  };
}
