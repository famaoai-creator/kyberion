/**
 * autonomy-action-state — evidence-driven autonomy promotion/demotion for
 * POLICY ACTIONS (distinct from the per-dot ladder in dot-autonomy.ts).
 *
 * The gate's score thresholds are global — raising `auto_max_score` from 3 to
 * 7 would auto-enable eight unrelated actions at once. This module instead
 * adjusts autonomy per action, from observed evidence, in two bounded tiers:
 *
 *   tier1  approve → notify   (needs PROMOTE_NOTIFY_* evidence)
 *   tier2  notify  → auto     (needs PROMOTE_AUTO_* evidence — stricter)
 *
 * Evidence lives in an append-only ledger
 * (observability/autonomy-outcomes.jsonl): every gate consumer records the
 * decision it received plus, when it executed, whether the action succeeded.
 * Promotion state lives in runtime/autonomy-action-overrides.json — a runtime
 * file, because rewriting governed policy from a daemon would dirty the repo.
 * Malformed state is ignored wholesale (fail-safe to the base decision).
 *
 * Demotion is instant and asymmetric: one incident or execution failure sets
 * `demoted_until`, forcing the base decision (or 'approve') until it lapses.
 */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { appendJsonLine, readJsonLines, readJsonIfPresent } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import type { AutonomousOpsDecision } from './autonomous-ops-gate.js';

const logger = createLogger('autonomy-action-state');

export const AUTONOMY_OUTCOMES_PATH = 'active/shared/observability/autonomy-outcomes.jsonl';
export const AUTONOMY_OVERRIDES_PATH = 'active/shared/runtime/autonomy-action-overrides.json';

/** Tier-1 (approve→notify): enough receipts, zero incidents. */
export const PROMOTE_NOTIFY_MIN_DECISIONS = 10;
/** Tier-2 (notify→auto): the policy's own promotion bar, applied per action. */
export const PROMOTE_AUTO_MIN_DECISIONS = 20;
export const PROMOTE_AUTO_MIN_OUTCOME_SUCCESS = 0.9;
export const PROMOTE_AUTO_MAX_INCIDENTS_30D = 0;
/** A demotion holds the base decision for this long before re-eligibility. */
export const DEMOTE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Stats window — promotion evidence ages out. */
export const AUTONOMY_STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface AutonomyOutcomeRow {
  action_id: string;
  /** What the gate decided for this invocation. */
  decision: AutonomousOpsDecision;
  /** Whether the caller actually executed the action. */
  executed: boolean;
  /** Execution result — true only when the action demonstrably succeeded. */
  ok?: boolean;
  error?: string;
  recorded_at: string;
}

interface ActionOverride {
  /** 'auto' | 'notify': relax the base decision toward this level. */
  relaxed_to?: AutonomousOpsDecision;
  promoted_at?: string;
  demoted_until?: string;
  demote_reason?: string;
  stats?: { decisions: number; succeeded: number; incidents: number };
}

interface ActionOverridesFile {
  version: 1;
  overrides: Record<string, ActionOverride>;
}

export interface AutonomyStateDeps {
  rootDir?: string;
  now?: () => Date;
}

function filePath(deps: AutonomyStateDeps, rel: string): string {
  return assertSafeRepositoryPath(path.join(deps.rootDir ?? pathResolver.rootDir(), rel), {
    allowMissingLeaf: true,
  });
}

/** Append a gate decision (and optional execution result) to the ledger. */
export function recordAutonomyOutcome(
  row: Omit<AutonomyOutcomeRow, 'recorded_at'>,
  deps: AutonomyStateDeps = {}
): void {
  const p = filePath(deps, AUTONOMY_OUTCOMES_PATH);
  safeMkdir(path.dirname(p), { recursive: true });
  appendJsonLine(p, {
    ...row,
    recorded_at: (deps.now?.() ?? new Date()).toISOString(),
  });
}

export interface AutonomyActionStats {
  decisions: number;
  /** Executed runs that returned ok=true. */
  succeeded: number;
  /** Executed runs that failed (ok=false) or produced an error. */
  incidents: number;
  /** executed && ok over all executed runs. */
  outcome_success: number;
}

export function actionAutonomyStats(
  actionId: string,
  deps: AutonomyStateDeps = {}
): AutonomyActionStats {
  const cutoff = (deps.now?.() ?? new Date()).getTime() - AUTONOMY_STATS_WINDOW_MS;
  const p = filePath(deps, AUTONOMY_OUTCOMES_PATH);
  const stats: AutonomyActionStats = {
    decisions: 0,
    succeeded: 0,
    incidents: 0,
    outcome_success: 0,
  };
  if (!safeExistsSync(p)) return stats;
  for (const row of readJsonLines<Partial<AutonomyOutcomeRow>>(p)) {
    if (row?.action_id !== actionId) continue;
    const ts = Date.parse(String(row.recorded_at ?? ''));
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    stats.decisions++;
    if (row.executed) {
      if (row.ok === true) stats.succeeded++;
      else stats.incidents++;
    }
  }
  const executed = stats.succeeded + stats.incidents;
  stats.outcome_success = executed > 0 ? stats.succeeded / executed : 0;
  return stats;
}

function loadOverrides(deps: AutonomyStateDeps): ActionOverridesFile {
  const p = filePath(deps, AUTONOMY_OVERRIDES_PATH);
  const parsed = readJsonIfPresent<ActionOverridesFile>(p);
  if (parsed?.version !== 1 || typeof parsed.overrides !== 'object' || parsed.overrides === null) {
    return { version: 1, overrides: {} };
  }
  return parsed;
}

function saveOverrides(state: ActionOverridesFile, deps: AutonomyStateDeps): void {
  const p = filePath(deps, AUTONOMY_OVERRIDES_PATH);
  safeMkdir(path.dirname(p), { recursive: true });
  safeWriteFile(p, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Apply runtime promotion/demotion to a gate decision. Demotion forces the
 * base decision (never relaxes); promotion lifts at most to `relaxed_to`
 * and never past 'auto'. Escalations (never_auto, high_risk, budget) are
 * applied by the caller before this — overrides cannot undo them.
 */
export function applyAutonomyOverride(
  actionId: string,
  decision: AutonomousOpsDecision,
  escalations: readonly string[],
  deps: AutonomyStateDeps = {}
): { decision: AutonomousOpsDecision; applied?: string } {
  const { overrides } = loadOverrides(deps);
  const o = overrides[actionId];
  if (!o) return { decision };
  const now = deps.now?.() ?? new Date();
  if (o.demoted_until && Date.parse(o.demoted_until) > now.getTime()) {
    return { decision: 'approve', applied: 'demoted' };
  }
  const rank: Record<AutonomousOpsDecision, number> = { approve: 0, notify: 1, auto: 2 };
  if (o.relaxed_to && escalations.length === 0 && rank[decision] < rank[o.relaxed_to]) {
    return { decision: o.relaxed_to, applied: `relaxed_to:${o.relaxed_to}` };
  }
  return { decision };
}

export interface AutonomySweepResult {
  promoted: string[];
  demoted: string[];
  held: string[];
}

/**
 * Recompute per-action overrides from the ledger. Called periodically (the
 * daemon watchdog sweeps at end of run). Promotion and demotion are
 * asymmetric by design: promotion needs sustained clean evidence; demotion
 * fires on a single fresh incident.
 */
export function sweepAutonomyActionStates(
  actionIds: readonly string[],
  deps: AutonomyStateDeps = {}
): AutonomySweepResult {
  const state = loadOverrides(deps);
  const now = deps.now?.() ?? new Date();
  const result: AutonomySweepResult = { promoted: [], demoted: [], held: [] };

  for (const actionId of actionIds) {
    const stats = actionAutonomyStats(actionId, deps);
    const existing = state.overrides[actionId] ?? {};
    const demotedUntil = existing.demoted_until ? Date.parse(existing.demoted_until) : 0;

    // Demotion wins outright: any fresh incident pushes demoted_until.
    if (stats.incidents > 0 && (!existing.demoted_until || demotedUntil < now.getTime())) {
      state.overrides[actionId] = {
        demoted_until: new Date(now.getTime() + DEMOTE_COOLDOWN_MS).toISOString(),
        demote_reason: `${stats.incidents} incident(s) in window`,
        stats: {
          decisions: stats.decisions,
          succeeded: stats.succeeded,
          incidents: stats.incidents,
        },
      };
      result.demoted.push(actionId);
      continue;
    }

    // Tier-2: notify→auto needs the strict bar.
    if (
      stats.decisions >= PROMOTE_AUTO_MIN_DECISIONS &&
      stats.outcome_success >= PROMOTE_AUTO_MIN_OUTCOME_SUCCESS &&
      stats.incidents <= PROMOTE_AUTO_MAX_INCIDENTS_30D
    ) {
      if (existing.relaxed_to !== 'auto') {
        state.overrides[actionId] = {
          ...existing,
          relaxed_to: 'auto',
          promoted_at: now.toISOString(),
          stats: {
            decisions: stats.decisions,
            succeeded: stats.succeeded,
            incidents: stats.incidents,
          },
        };
        result.promoted.push(`${actionId}→auto`);
        continue;
      }
    }

    // Tier-1: approve→notify is cheaper — sustained volume, zero incidents.
    if (
      !existing.relaxed_to &&
      stats.decisions >= PROMOTE_NOTIFY_MIN_DECISIONS &&
      stats.incidents === 0
    ) {
      state.overrides[actionId] = {
        relaxed_to: 'notify',
        promoted_at: now.toISOString(),
        stats: {
          decisions: stats.decisions,
          succeeded: stats.succeeded,
          incidents: stats.incidents,
        },
      };
      result.promoted.push(`${actionId}→notify`);
      continue;
    }
    result.held.push(actionId);
  }

  if (result.promoted.length || result.demoted.length) {
    saveOverrides(state, deps);
    logger.info(
      `[AUTONOMY] sweep: promoted=[${result.promoted.join(',')}] demoted=[${result.demoted.join(',')}]`
    );
  }
  return result;
}
