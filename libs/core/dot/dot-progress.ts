/** Outcome-driven continuation and deterministic, metric-local replanning context.
 * The existing outcome ledger is the durable source; no second delivery store.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonLinesCached } from '../jsonl-tail.js';
import { pathResolver } from '../path-resolver.js';
import type { DotCharter } from './dot-charter.js';
import type { DotPromptSection, DotStatusSection } from './dot-extensions.js';
import { DOT_OUTCOMES_FILE, dotStatePath, type DotOutcomeRow } from './dot-state-paths.js';

export const DOT_PROGRESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const DOT_REPLAN_STREAK = 2;
const VERDICTS = new Set(['improved', 'no_change', 'regressed', 'unmeasurable']);

interface ProgressDeps {
  rootDir?: string;
  now?: () => Date;
}

/** Immutable first verdict per action, in APPEND order, including late arrivals.
 * Future/unsettled/malformed rows are not evidence. Duplicate appends cannot
 * revive a consumed continuation or inflate a stagnation streak.
 */
export function readDotProgressOutcomes(c: DotCharter, deps: ProgressDeps = {}): DotOutcomeRow[] {
  const now = (deps.now?.() ?? new Date()).getTime();
  const rows = readJsonLinesCached<DotOutcomeRow>(
    path.join(deps.rootDir ?? pathResolver.rootDir(), dotStatePath(c, DOT_OUTCOMES_FILE))
  );
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (
      !row ||
      row.dot_id !== c.dot_id ||
      typeof row.action_ref !== 'string' ||
      !row.action_ref ||
      typeof row.work_item_id !== 'string' ||
      !row.work_item_id ||
      !VERDICTS.has(row.verdict) ||
      !row.ref ||
      typeof row.ref !== 'object' ||
      Array.isArray(row.ref) ||
      (row.ref.kr_id !== undefined && typeof row.ref.kr_id !== 'string') ||
      (row.ref.signal !== undefined && typeof row.ref.signal !== 'string') ||
      typeof row.measured_at !== 'string' ||
      typeof row.due_at !== 'string' ||
      !Number.isFinite(Date.parse(row.measured_at)) ||
      !Number.isFinite(Date.parse(row.due_at)) ||
      Date.parse(row.measured_at) > now ||
      Date.parse(row.measured_at) < Date.parse(row.due_at) ||
      (row.before !== undefined && !Number.isFinite(row.before)) ||
      (row.after !== undefined && !Number.isFinite(row.after)) ||
      (row.verdict !== 'unmeasurable' &&
        (!Number.isFinite(row.before) || !Number.isFinite(row.after))) ||
      seen.has(row.action_ref)
    )
      return false;
    seen.add(row.action_ref);
    return true;
  });
}

/** One wake covers the currently visible prefix. A later append gets a new key,
 * including when its measurement timestamp is older than the previous result.
 * Hash every eligible identity: clock-skewed evidence becoming valid also
 * advances the watermark even if it precedes the last appended result.
 * Detail is constant: tenant metric names/numbers never enter the shared ledger.
 */
export function dotOutcomeContinuation(
  c: DotCharter,
  deps: ProgressDeps = {}
): { key: string; detail: string } | undefined {
  const rows = readDotProgressOutcomes(c, deps);
  if (!rows.length) return undefined;
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        c.scope.tier,
        c.scope.tenant_slug ?? null,
        c.scope.organization_id ?? null,
        c.scope.project_id ?? null,
        c.dot_id,
        rows.map((row) => row.action_ref),
      ])
    )
    .digest('hex');
  return {
    key: `outcome:${key}`,
    detail: 'Settled action outcomes are ready; reassess progress before proposing work.',
  };
}

export interface DotProgressSummary {
  ref: DotOutcomeRow['ref'];
  state: 'progressing' | 'satisfied' | 'observing' | 'replan' | 'measurement_needed';
  non_improving_streak: number;
  action_ref: string;
}

function targetMet(c: DotCharter, row: DotOutcomeRow): boolean {
  const spec = c.goal.key_results?.find((s) => s.kr_id === row.ref.kr_id);
  if (!spec || row.after === undefined || row.verdict === 'unmeasurable') return false;
  const tol = Math.max(Math.abs(spec.target) * 0.01, 1e-9);
  if (spec.direction === 'decrease') return row.after <= spec.target + tol;
  if (spec.direction === 'increase') return row.after >= spec.target - tol;
  return Math.abs(row.after - spec.target) <= tol;
}

export function dotProgressSummary(c: DotCharter, deps: ProgressDeps = {}): DotProgressSummary[] {
  const now = deps.now?.() ?? new Date();
  const groups = new Map<string, DotProgressSummary>();
  // Measurement order for streaks; append order remains the delivery watermark.
  // Stable sorting preserves append order when measurement times are equal.
  const rows = readDotProgressOutcomes(c, { ...deps, now: () => now }).sort(
    (a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at)
  );
  for (const row of rows) {
    if (Date.parse(row.measured_at) < now.getTime() - DOT_PROGRESS_WINDOW_MS) continue;
    // Unknown effects need measurement repair; they cannot form a fake KR streak.
    const key = JSON.stringify([row.ref.kr_id ?? null, row.ref.signal ?? null]);
    const previous = groups.get(key);
    const satisfied = targetMet(c, row);
    const streak =
      row.verdict === 'no_change' || row.verdict === 'regressed'
        ? satisfied
          ? 0
          : (previous?.non_improving_streak ?? 0) + 1
        : 0;
    const state = satisfied
      ? 'satisfied'
      : row.verdict === 'unmeasurable'
        ? 'measurement_needed'
        : row.verdict === 'improved'
          ? 'progressing'
          : streak >= DOT_REPLAN_STREAK
            ? 'replan'
            : 'observing';
    groups.delete(key);
    groups.set(key, {
      ref: row.ref,
      state,
      non_improving_streak: streak,
      action_ref: row.action_ref,
    });
  }
  return [...groups.values()].reverse();
}

export function dotProgressPromptSection(): DotPromptSection {
  return {
    id: 'dot-progress',
    order: 46,
    lines(c, ctx) {
      const progress = dotProgressSummary(c, ctx);
      if (!progress.length) return [];
      return [
        'Goal progress (execution success alone does not establish goal achievement):',
        ...progress.slice(0, 10).map((p) => {
          const subject = p.ref.kr_id ?? p.ref.signal ?? 'unknown effect';
          const next =
            p.state === 'replan'
              ? 'Change hypothesis, tool or decomposition before proposing more work; record the new hypothesis in dot memory. Do not repeat the same plan unchanged.'
              : p.state === 'measurement_needed'
                ? 'Repair measurement or declare an expected_effect before attempting more work; do not infer success.'
                : p.state === 'satisfied'
                  ? 'Target met; monitor it rather than creating redundant corrective work.'
                  : 'Check the remaining goal gap and evidence before choosing the next action.';
          return `- ${subject}: ${p.state} (non-improving streak ${p.non_improving_streak}). ${next}`;
        }),
        'Keep all replanned actions within charter authority, approval and budget limits. If blocked, identify the dependency and use a bounded follow-up or an existing event/probe trigger; do not poll by repeating the failed action.',
      ];
    },
  };
}

export function dotProgressStatusSection(): DotStatusSection {
  return { id: 'progress', collect: (c, ctx) => ({ progress: dotProgressSummary(c, ctx) }) };
}
