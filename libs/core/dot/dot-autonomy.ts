/**
 * Dot graduated autonomy (DL-10) — the L0–L4 ladder a resident dot climbs
 * only with a human's consent and slides down automatically on trouble.
 *
 *   L0 shadow      every proposal needs approval; settled decisions feed the
 *                  shadow ledger (true never-dispatch shadow needs a dispatch
 *                  hook — until then L0 gates like L1).
 *   L1 approve-all every proposal needs approval.
 *   L2 supervised  today's behaviour (policy gate + charter floor + learned
 *                  floor that lifts after three human approvals). Default.
 *   L3 trusted     the learned floor lifts after ONE human approval and
 *                  decays seven days after the rejection.
 *   L4 autonomous  L3, plus notify → auto for policy `autonomy.relaxable_actions`
 *                  that are reversible, touch no high-risk path, are not a
 *                  never_auto class or a policy approve, while the dot's
 *                  outcome success rate stays ≥ the promotion bar.
 *
 * The charter floor (`decisions.default_decision`) and the policy gate are
 * never lowered: the relaxer below only proposes, dot-dispatch clamps.
 *
 * State `autonomy/<dot>.json`; shadow ledger `autonomy-shadow.jsonl` (what the
 * next level up would have decided vs. the human's outcome). The supervisor
 * step demotes automatically (notify + audit) and opens a promotion decision
 * card (gate forced to approve) that is applied only after a HUMAN approval
 * has settled in a later sweep.
 *
 * Import-cycle note: dot-extension-registry imports this module, and
 * dot-dispatch imports the registry, so registrations are hoisted factory
 * functions and dot-dispatch is only reached through call-time functions.
 */

import * as path from 'node:path';
import { appendJsonLine, readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import {
  routeAutonomousDecision,
  type RouteAutonomousDecisionInput,
  type RoutedDecision,
} from '../governance/approval-decision-routing.js';
import { loadApprovalRequest, type ApprovalRequestRecord } from '../governance/approval-store.js';
import { VETO_WINDOW_DECIDER } from '../governance/approval-veto-window.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  evaluateAutonomousOpsAction,
  getAutonomousOpsPolicy,
  type AutonomousOpsGateInput,
  type AutonomousOpsGateResult,
} from '../governance/autonomous-ops-gate.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import {
  notifyOperatorSync,
  type OperatorEvent,
  type OperatorNotificationOptions,
  type OperatorNotificationPayload,
} from '../surface/operator-notifications.js';
import type { DotCharter } from './dot-charter.js';
import {
  currentDotActions,
  dotNotificationRoute,
  dotQuietHours,
  type DotActionRecord,
} from './dot-dispatch.js';
import type {
  DotDecisionRelaxer,
  DotDigestSection,
  DotExtCtx,
  DotFloorContributor,
  DotStatusSection,
} from './dot-extensions.js';
import { readDotFeedback, type DotFeedbackEntry } from './dot-feedback.js';
import { dotOutcomeStats } from './dot-outcomes.js';
import type { DotDecisionLevel } from './dot-proposals.js';
import {
  DOT_AUTONOMY_LEVELS,
  DOT_AUTONOMY_SHADOW_FILE,
  DOT_OUTCOMES_FILE,
  DOT_WORK_RESULTS_FILE,
  dotAutonomyStatePath,
  dotStatePath,
  type DotAutonomyLevel,
  type DotAutonomyState,
  type DotOutcomeRow,
  type DotWorkResultRow,
} from './dot-state-paths.js';

const logger = createLogger('dot-autonomy');

export const DOT_AUTONOMY_DEFAULT_LEVEL: DotAutonomyLevel = 'L2';
export const DOT_AUTONOMY_DEFAULT_MAX_LEVEL: DotAutonomyLevel = 'L3';
/** Automatic demotion never goes below this unless the charter's min_level says so. */
export const DOT_AUTONOMY_DEFAULT_DEMOTION_FLOOR: DotAutonomyLevel = 'L1';
/** L3: human approvals after the latest rejection that lift the learned floor. */
export const DOT_AUTONOMY_L3_RELEASE_APPROVALS = 1;
/** L3: a rejection older than this no longer holds the learned floor. */
export const DOT_AUTONOMY_L3_DECAY_MS = 7 * 24 * 60 * 60 * 1000;
/** Window for promotion metrics (decisions, outcomes, incidents). */
export const DOT_AUTONOMY_METRICS_DAYS = 30;
export const DOT_AUTONOMY_HISTORY_LIMIT = 50;
/** Synthetic action id carried by promotion decision cards (never executed). */
export const DOT_AUTONOMY_PROMOTION_ACTION_ID = 'dot_autonomy_promotion';
/** libs/core governed stores (approvals) write under this shared role. */
const GOVERNED_STORE_ROLE = 'infrastructure_sentinel';
const L2_RELEASE_APPROVALS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DECISION_RANK: Record<DotDecisionLevel, number> = { auto: 0, notify: 1, approve: 2 };
/** Gate escalations that a relaxation must never undercut. */
const HARD_ESCALATIONS = new Set(['never_auto', 'high_risk_path', 'axis_max', 'budget']);

export interface DotAutonomyPolicy {
  relaxable_actions: string[];
  promotion: {
    min_decisions: number;
    min_agreement: number;
    min_outcome_success: number;
    max_incidents_30d: number;
  };
  demotion: {
    on_regressed_outcomes: number;
    on_rejection_streak: number;
    on_incident: boolean;
  };
}

export const DEFAULT_DOT_AUTONOMY_POLICY: DotAutonomyPolicy = {
  relaxable_actions: ['dot_delegate_work'],
  promotion: {
    min_decisions: 20,
    min_agreement: 0.9,
    min_outcome_success: 0.8,
    max_incidents_30d: 0,
  },
  demotion: { on_regressed_outcomes: 2, on_rejection_streak: 2, on_incident: true },
};

/** Persisted state: the shared contract plus the pending promotion card. */
export interface DotAutonomyStateDoc extends DotAutonomyState {
  dot_id: string;
  pending_promotion?: { to: DotAutonomyLevel; request_id: string; requested_at: string };
  /** UTC day (YYYY-MM-DD) of the last promotion evaluation. */
  last_promotion_check_day?: string;
}

/** One settled human decision compared with what the next level up would have decided. */
export interface DotAutonomyShadowRow {
  dot_id: string;
  action_ref: string;
  action_id: string;
  level: DotAutonomyLevel;
  next_level: DotAutonomyLevel;
  would_have: DotDecisionLevel;
  actual_decision?: DotDecisionLevel;
  human_outcome: 'approved' | 'rejected';
  /** False only when the next level would have proceeded on work the human rejected. */
  agree: boolean;
  settled_at: string;
  recorded_at: string;
}

export interface DotAutonomyMetrics {
  level: DotAutonomyLevel;
  next_level?: DotAutonomyLevel;
  decisions: number;
  agreement_rate: number;
  outcome_success_rate: number;
  outcomes_judged: number;
  incidents_30d: number;
  executor_incidents_30d: number;
  regressed_outcomes_30d: number;
  rejection_streak: number;
  /** Counters since the last level change (drive demotion). */
  since_level_change: {
    executor_incidents: number;
    regressed_outcomes: number;
    rejection_streak: number;
  };
}

export interface DotAutonomyDeps {
  rootDir?: string;
  now?: () => Date;
  policy?: DotAutonomyPolicy;
  /** Policy gate port (shadow would-have computation). */
  gate?: (input: AutonomousOpsGateInput) => AutonomousOpsGateResult;
  route?: (input: RouteAutonomousDecisionInput) => RoutedDecision;
  loadApproval?: (requestId: string) => ApprovalRequestRecord | null;
  notify?: (
    event: OperatorEvent,
    payload: OperatorNotificationPayload,
    options: OperatorNotificationOptions
  ) => boolean;
  audit?: (entry: Parameters<typeof auditChain.record>[0]) => void;
  /** Outcome stats port (DL-04); defaults to dotOutcomeStats, falling back to outcomes.jsonl. */
  outcomeStats?: (
    c: DotCharter,
    opts: { sinceDays?: number; rootDir?: string; now?: () => Date }
  ) => { improved: number; no_change: number; regressed: number; success_rate: number };
  /** Settled actions for this dot; defaults to the dot action ledger. */
  listActions?: (dotId: string) => DotActionRecord[];
}

// ---------------------------------------------------------------------------
// levels
// ---------------------------------------------------------------------------

export function dotAutonomyLevelRank(level: DotAutonomyLevel): number {
  return DOT_AUTONOMY_LEVELS.indexOf(level);
}

function isLevel(value: unknown): value is DotAutonomyLevel {
  return typeof value === 'string' && (DOT_AUTONOMY_LEVELS as readonly string[]).includes(value);
}

/** Charter bounds: min defaults to L0, max to L3 (a max below min collapses to max). */
export function dotAutonomyBounds(c: DotCharter): { min: DotAutonomyLevel; max: DotAutonomyLevel } {
  const max = c.autonomy?.max_level ?? DOT_AUTONOMY_DEFAULT_MAX_LEVEL;
  const min = c.autonomy?.min_level ?? 'L0';
  return dotAutonomyLevelRank(min) > dotAutonomyLevelRank(max) ? { min: max, max } : { min, max };
}

export function clampDotAutonomyLevel(c: DotCharter, level: DotAutonomyLevel): DotAutonomyLevel {
  const { min, max } = dotAutonomyBounds(c);
  const rank = Math.min(
    Math.max(dotAutonomyLevelRank(level), dotAutonomyLevelRank(min)),
    dotAutonomyLevelRank(max)
  );
  return DOT_AUTONOMY_LEVELS[rank];
}

function strictest(...levels: Array<DotDecisionLevel | undefined>): DotDecisionLevel | undefined {
  let result: DotDecisionLevel | undefined;
  for (const level of levels) {
    if (level && (!result || DECISION_RANK[level] > DECISION_RANK[result])) result = level;
  }
  return result;
}

export function loadDotAutonomyPolicy(
  deps: Pick<DotAutonomyDeps, 'policy'> = {}
): DotAutonomyPolicy {
  if (deps.policy) return deps.policy;
  try {
    const section = (getAutonomousOpsPolicy() as { autonomy?: Partial<DotAutonomyPolicy> })
      .autonomy;
    if (!section) return DEFAULT_DOT_AUTONOMY_POLICY;
    return {
      relaxable_actions: section.relaxable_actions ?? DEFAULT_DOT_AUTONOMY_POLICY.relaxable_actions,
      promotion: { ...DEFAULT_DOT_AUTONOMY_POLICY.promotion, ...(section.promotion ?? {}) },
      demotion: { ...DEFAULT_DOT_AUTONOMY_POLICY.demotion, ...(section.demotion ?? {}) },
    };
  } catch {
    return DEFAULT_DOT_AUTONOMY_POLICY;
  }
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

function nowOf(deps: { now?: () => Date }): Date {
  return deps.now?.() ?? new Date();
}

function abs(deps: { rootDir?: string }, rel: string): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), rel);
}

function initialState(c: DotCharter, now: Date): DotAutonomyStateDoc {
  return {
    dot_id: c.dot_id,
    level: clampDotAutonomyLevel(c, c.autonomy?.initial_level ?? DOT_AUTONOMY_DEFAULT_LEVEL),
    since: now.toISOString(),
    history: [],
  };
}

/** Stored state (level clamped to the charter's current bounds), or the initial state. */
export function readDotAutonomyState(
  c: DotCharter,
  deps: Pick<DotAutonomyDeps, 'rootDir' | 'now'> = {}
): DotAutonomyStateDoc & { persisted: boolean } {
  let stored: DotAutonomyStateDoc | null = null;
  try {
    stored = readJsonIfPresent<DotAutonomyStateDoc>(abs(deps, dotAutonomyStatePath(c)));
  } catch (error) {
    logger.warn(
      `autonomy state unreadable for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: the dot runs at its initial level until the file is fixed | evidence: ${dotAutonomyStatePath(c)}`
    );
  }
  if (!stored || !isLevel(stored.level))
    return { ...initialState(c, nowOf(deps)), persisted: false };
  return {
    ...stored,
    dot_id: c.dot_id,
    level: clampDotAutonomyLevel(c, stored.level),
    history: Array.isArray(stored.history) ? stored.history : [],
    persisted: true,
  };
}

export function writeDotAutonomyState(
  c: DotCharter,
  state: DotAutonomyStateDoc,
  deps: Pick<DotAutonomyDeps, 'rootDir'> = {}
): void {
  const file = abs(deps, dotAutonomyStatePath(c));
  safeMkdir(path.dirname(file), { recursive: true });
  const { persisted: _persisted, ...doc } = state as DotAutonomyStateDoc & { persisted?: boolean };
  writeJson(file, { ...doc, history: doc.history.slice(-DOT_AUTONOMY_HISTORY_LIMIT) });
}

/** The level the gate hooks use right now. */
export function dotAutonomyLevel(
  c: DotCharter,
  deps: Pick<DotAutonomyDeps, 'rootDir' | 'now'> = {}
): DotAutonomyLevel {
  return readDotAutonomyState(c, deps).level;
}

function changeLevel(
  c: DotCharter,
  state: DotAutonomyStateDoc,
  to: DotAutonomyLevel,
  reason: string,
  now: Date
): DotAutonomyStateDoc {
  const { pending_promotion: _pending, ...rest } = state;
  return {
    ...rest,
    level: to,
    since: now.toISOString(),
    history: [...state.history, { level: to, at: now.toISOString(), reason }],
  };
}

// ---------------------------------------------------------------------------
// learned floor per level + decision semantics
// ---------------------------------------------------------------------------

function isHumanApproval(row: DotFeedbackEntry): boolean {
  return (
    row.outcome === 'approved' &&
    row.decided_by_type === 'human' &&
    row.decided_by !== VETO_WINDOW_DECIDER
  );
}

/**
 * True while the latest rejection still holds the learned floor under the
 * level's release rule (L2: three human approvals; L3/L4: one, or seven days).
 */
export function dotLearnedFloorHolds(
  rows: readonly DotFeedbackEntry[],
  level: DotAutonomyLevel,
  at: Date
): boolean {
  let last = -1;
  rows.forEach((row, index) => {
    if (row.outcome === 'rejected') last = index;
  });
  if (last < 0) return false;
  const approvals = rows.slice(last + 1).filter(isHumanApproval).length;
  if (dotAutonomyLevelRank(level) >= dotAutonomyLevelRank('L3')) {
    if (at.getTime() - Date.parse(rows[last].recorded_at) >= DOT_AUTONOMY_L3_DECAY_MS) return false;
    return approvals < DOT_AUTONOMY_L3_RELEASE_APPROVALS;
  }
  return approvals < L2_RELEASE_APPROVALS;
}

export interface DotAutonomyDecisionInput {
  /** The policy gate's own decision (no learned floor). */
  policyDecision: DotDecisionLevel;
  /** charter.decisions.default_decision and any other hard floor. */
  hardFloor?: DotDecisionLevel;
  /** The learned floor still holds under the level's release rule. */
  learnedHolds: boolean;
  /** L4 relaxation preconditions (relaxable action, reversible, no high-risk, outcomes ok). */
  l4Eligible: boolean;
}

/**
 * Intended decision of a level. Never below the hard floor; never below the
 * policy decision except L4's notify → auto for an eligible action (a policy
 * approve is never relaxed). dot-dispatch currently clamps relaxations at the
 * policy gate too, so the L4 relaxation only takes effect once dispatch lets
 * it through.
 */
export function dotAutonomyDecisionAt(
  level: DotAutonomyLevel,
  input: DotAutonomyDecisionInput
): DotDecisionLevel {
  if (level === 'L0' || level === 'L1') return 'approve';
  const learned = input.learnedHolds ? 'approve' : undefined;
  const base = strictest(input.policyDecision, input.hardFloor, learned) ?? 'approve';
  if (
    level === 'L4' &&
    input.l4Eligible &&
    base === 'notify' &&
    input.policyDecision === 'notify' &&
    !learned &&
    (!input.hardFloor || DECISION_RANK[input.hardFloor] < DECISION_RANK.notify)
  ) {
    return 'auto';
  }
  return base;
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

function readOutcomeRows(c: DotCharter, deps: { rootDir?: string }): DotOutcomeRow[] {
  return readJsonLines<DotOutcomeRow>(abs(deps, dotStatePath(c, DOT_OUTCOMES_FILE)), {
    onMalformed: 'skip',
  }).filter((row) => row?.dot_id === c.dot_id && typeof row.verdict === 'string');
}

function outcomeStats(
  c: DotCharter,
  sinceDays: number,
  deps: DotAutonomyDeps
): { judged: number; regressed: number; success_rate: number } {
  const opts = { sinceDays, rootDir: deps.rootDir, now: deps.now };
  try {
    const s = (deps.outcomeStats ?? dotOutcomeStats)(c, opts);
    return {
      judged: s.improved + s.no_change + s.regressed,
      regressed: s.regressed,
      success_rate: s.success_rate,
    };
  } catch {
    const cutoff = nowOf(deps).getTime() - sinceDays * DAY_MS;
    const rows = readOutcomeRows(c, deps).filter((row) => Date.parse(row.measured_at) >= cutoff);
    const improved = rows.filter((row) => row.verdict === 'improved').length;
    const regressed = rows.filter((row) => row.verdict === 'regressed').length;
    const judged = improved + regressed + rows.filter((row) => row.verdict === 'no_change').length;
    return { judged, regressed, success_rate: judged === 0 ? 0 : improved / judged };
  }
}

function regressedSince(c: DotCharter, since: number, deps: DotAutonomyDeps): number {
  return readOutcomeRows(c, deps).filter(
    (row) => row.verdict === 'regressed' && Date.parse(row.measured_at) >= since
  ).length;
}

function executorIncidentsSince(c: DotCharter, since: number, deps: DotAutonomyDeps): number {
  return readJsonLines<DotWorkResultRow>(abs(deps, dotStatePath(c, DOT_WORK_RESULTS_FILE)), {
    onMalformed: 'skip',
  }).filter(
    (row) =>
      row?.dot_id === c.dot_id &&
      (row.status === 'failed' || row.status === 'blocked') &&
      Date.parse(row.completed_at) >= since
  ).length;
}

/** Trailing consecutive rejections (expired / cancelled decisions are skipped). */
function rejectionStreak(rows: readonly DotFeedbackEntry[], since = -Infinity): number {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (Date.parse(row.recorded_at) < since) break;
    if (row.outcome === 'rejected') streak += 1;
    else if (row.outcome === 'approved') break;
  }
  return streak;
}

export function readDotAutonomyShadow(
  c: DotCharter,
  deps: Pick<DotAutonomyDeps, 'rootDir'> = {}
): DotAutonomyShadowRow[] {
  return readJsonLines<DotAutonomyShadowRow>(abs(deps, dotStatePath(c, DOT_AUTONOMY_SHADOW_FILE)), {
    onMalformed: 'skip',
  }).filter((row) => row?.dot_id === c.dot_id && typeof row.action_ref === 'string');
}

function nextLevel(c: DotCharter, level: DotAutonomyLevel): DotAutonomyLevel | undefined {
  const rank = dotAutonomyLevelRank(level);
  const { max } = dotAutonomyBounds(c);
  return rank < dotAutonomyLevelRank(max) ? DOT_AUTONOMY_LEVELS[rank + 1] : undefined;
}

export function dotAutonomyMetrics(c: DotCharter, deps: DotAutonomyDeps = {}): DotAutonomyMetrics {
  const now = nowOf(deps);
  const state = readDotAutonomyState(c, deps);
  const cutoff = now.getTime() - DOT_AUTONOMY_METRICS_DAYS * DAY_MS;
  const since = Date.parse(state.since);
  const next = nextLevel(c, state.level);
  const shadow = readDotAutonomyShadow(c, deps).filter(
    (row) =>
      row.level === state.level &&
      (!next || row.next_level === next) &&
      Date.parse(row.recorded_at) >= cutoff
  );
  const outcomes = outcomeStats(c, DOT_AUTONOMY_METRICS_DAYS, deps);
  const executor = executorIncidentsSince(c, cutoff, deps);
  const feedback = readDotFeedback(c.dot_id, deps);
  return {
    level: state.level,
    ...(next ? { next_level: next } : {}),
    decisions: shadow.length,
    agreement_rate: shadow.length ? shadow.filter((row) => row.agree).length / shadow.length : 0,
    outcome_success_rate: outcomes.success_rate,
    outcomes_judged: outcomes.judged,
    incidents_30d: executor + outcomes.regressed,
    executor_incidents_30d: executor,
    regressed_outcomes_30d: outcomes.regressed,
    rejection_streak: rejectionStreak(feedback),
    since_level_change: {
      executor_incidents: executorIncidentsSince(c, since, deps),
      regressed_outcomes: regressedSince(c, since, deps),
      rejection_streak: rejectionStreak(feedback, since),
    },
  };
}

// ---------------------------------------------------------------------------
// gate hooks
// ---------------------------------------------------------------------------

/** L0 / L1: every proposal needs an operator decision. */
export function dotAutonomyFloorContributor(): DotFloorContributor {
  return {
    id: 'autonomy',
    floor(c, _p, ctx) {
      const level = dotAutonomyLevel(c, ctx);
      return level === 'L0' || level === 'L1' ? 'approve' : undefined;
    },
  };
}

function l4Eligible(
  c: DotCharter,
  actionId: string,
  gate: Pick<AutonomousOpsGateResult, 'escalations' | 'highRiskPathMatches' | 'axes' | 'shadow'>,
  policyDecision: DotDecisionLevel | undefined,
  deps: DotAutonomyDeps
): boolean {
  const policy = loadDotAutonomyPolicy(deps);
  if (!policy.relaxable_actions.includes(actionId)) return false;
  if (policyDecision === 'approve' || gate.shadow) return false;
  if ((gate.escalations ?? []).some((rule) => HARD_ESCALATIONS.has(rule))) return false;
  if ((gate.highRiskPathMatches ?? []).length > 0) return false;
  if ((gate.axes?.reversibility ?? 3) >= 2) return false;
  const outcomes = outcomeStats(c, DOT_AUTONOMY_METRICS_DAYS, deps);
  return outcomes.judged > 0 && outcomes.success_rate >= policy.promotion.min_outcome_success;
}

/**
 * L3 / L4: lift the learned floor under the trusted release rule; L4 also asks
 * for auto on an eligible relaxable action. dot-dispatch clamps the answer to
 * the policy gate and the charter floor, so this can never lower either.
 */
export function dotAutonomyDecisionRelaxer(
  deps: Omit<DotAutonomyDeps, 'rootDir' | 'now'> = {}
): DotDecisionRelaxer {
  return {
    id: 'autonomy',
    relax(c, p, gate, _floor, ctx) {
      const d: DotAutonomyDeps = { ...deps, rootDir: ctx.rootDir, now: ctx.now };
      const level = dotAutonomyLevel(c, d);
      if (level !== 'L3' && level !== 'L4') return undefined;
      // The gate it receives already carries the learned floor; hard escalations still block.
      if ((gate.escalations ?? []).some((rule) => HARD_ESCALATIONS.has(rule))) return undefined;
      const rows = readDotFeedback(c.dot_id, d);
      if (dotLearnedFloorHolds(rows, level, ctx.now())) return undefined;
      if (level === 'L4' && l4Eligible(c, p.action_id, gate, undefined, d)) {
        return {
          decision: 'auto',
          reason: `autonomy ${level}: relaxable, reversible, outcomes on track`,
        };
      }
      return {
        decision: 'auto',
        reason: `autonomy ${level}: learned floor released (1 human approval or 7-day decay)`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// shadow ledger
// ---------------------------------------------------------------------------

function defaultGate(
  deps: DotAutonomyDeps
): (input: AutonomousOpsGateInput) => AutonomousOpsGateResult {
  return deps.gate ?? evaluateAutonomousOpsAction;
}

/**
 * Record one shadow row per human-settled decision not yet in the ledger:
 * what the next level up would have decided vs. what the human did.
 * Idempotent per action_ref. Returns the rows appended.
 */
export function recordDotAutonomyShadow(
  c: DotCharter,
  deps: DotAutonomyDeps = {}
): DotAutonomyShadowRow[] {
  const now = nowOf(deps);
  const state = readDotAutonomyState(c, deps);
  const next = nextLevel(c, state.level) ?? state.level;
  const seen = new Set(readDotAutonomyShadow(c, deps).map((row) => row.action_ref));
  const feedback = readDotFeedback(c.dot_id, deps);
  const actions = new Map(
    (deps.listActions ?? ((id: string) => currentDotActions(id, { rootDir: deps.rootDir })))(
      c.dot_id
    ).map((row) => [row.action_ref, row])
  );
  const file = abs(deps, dotStatePath(c, DOT_AUTONOMY_SHADOW_FILE));
  const appended: DotAutonomyShadowRow[] = [];
  feedback.forEach((entry, index) => {
    if (seen.has(entry.action_ref)) return;
    const human = isHumanApproval(entry) || entry.outcome === 'rejected';
    if (!human || (entry.outcome !== 'approved' && entry.outcome !== 'rejected')) return;
    const action = actions.get(entry.action_ref);
    const policyGate = defaultGate(deps)({
      actionId: entry.action_id,
      ...(c.scope.tenant_slug ? { tenantSlug: c.scope.tenant_slug } : {}),
    });
    // The record's gate decision carries the floors; when it exceeds the floor
    // the policy (e.g. a high-risk path) raised it on its own.
    const recorded = action?.gate_decision;
    const policyDecision =
      recorded && (!action?.floor || DECISION_RANK[recorded] > DECISION_RANK[action.floor])
        ? recorded
        : policyGate.decision;
    const decidedAt = new Date(entry.recorded_at);
    const before = feedback.slice(0, index);
    const wouldHave = dotAutonomyDecisionAt(next, {
      policyDecision,
      hardFloor: c.decisions?.default_decision,
      learnedHolds: dotLearnedFloorHolds(before, next, decidedAt),
      l4Eligible: l4Eligible(c, entry.action_id, policyGate, policyDecision, deps),
    });
    const row: DotAutonomyShadowRow = {
      dot_id: c.dot_id,
      action_ref: entry.action_ref,
      action_id: entry.action_id,
      level: state.level,
      next_level: next,
      would_have: wouldHave,
      ...(recorded ? { actual_decision: recorded } : {}),
      human_outcome: entry.outcome,
      agree: !(entry.outcome === 'rejected' && wouldHave !== 'approve'),
      settled_at: entry.recorded_at,
      recorded_at: now.toISOString(),
    };
    safeMkdir(path.dirname(file), { recursive: true });
    appendJsonLine(file, row);
    seen.add(entry.action_ref);
    appended.push(row);
  });
  return appended;
}

// ---------------------------------------------------------------------------
// supervisor step: demotion, promotion card, settlement
// ---------------------------------------------------------------------------

function audit(
  c: DotCharter,
  operation: string,
  metadata: Record<string, unknown>,
  deps: DotAutonomyDeps
): void {
  const actor = `dot:${c.dot_id}`;
  try {
    (deps.audit ?? ((entry) => auditChain.record(entry)))({
      agentId: actor,
      actor: { kind: 'agent', id: actor, display_name: c.title },
      action: 'dot_autonomy',
      operation,
      result: 'completed',
      metadata: { dot_id: c.dot_id, ...metadata },
      ...(c.scope.tenant_slug ? { tenantSlug: c.scope.tenant_slug } : {}),
    });
  } catch (error) {
    logger.warn(
      `autonomy audit write failed for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: the state file still records ${operation} | evidence: ${dotAutonomyStatePath(c)}`
    );
  }
}

function notify(c: DotCharter, title: string, body: string, deps: DotAutonomyDeps): void {
  try {
    (deps.notify ?? notifyOperatorSync)(
      'decision_digest',
      { title: `[dot:${c.dot_id}] ${title}`, body, correlation_id: `dot-autonomy:${c.dot_id}` },
      { route: dotNotificationRoute(c), quietHours: dotQuietHours(c) }
    );
  } catch (error) {
    logger.warn(
      `autonomy notification failed for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: the change is in the digest and audit chain | evidence: ${dotAutonomyStatePath(c)}`
    );
  }
}

export function dotAutonomyDemotionReason(
  metrics: DotAutonomyMetrics,
  policy: DotAutonomyPolicy
): string | undefined {
  const s = metrics.since_level_change;
  if (s.regressed_outcomes >= policy.demotion.on_regressed_outcomes) {
    return `${s.regressed_outcomes} regressed outcomes`;
  }
  if (s.rejection_streak >= policy.demotion.on_rejection_streak) {
    return `${s.rejection_streak} rejections in a row`;
  }
  if (policy.demotion.on_incident && s.executor_incidents > 0) {
    return `${s.executor_incidents} executor incident(s) (failed/blocked work)`;
  }
  return undefined;
}

export function dotAutonomyPromotionReady(
  metrics: DotAutonomyMetrics,
  policy: DotAutonomyPolicy
): { ready: boolean; missing: string[] } {
  const p = policy.promotion;
  const missing: string[] = [];
  if (!metrics.next_level) missing.push('at max level');
  if (metrics.decisions < p.min_decisions)
    missing.push(`decisions ${metrics.decisions}/${p.min_decisions}`);
  if (metrics.agreement_rate < p.min_agreement)
    missing.push(`agreement ${metrics.agreement_rate.toFixed(2)}<${p.min_agreement}`);
  if (metrics.outcome_success_rate < p.min_outcome_success) {
    missing.push(
      `outcome success ${metrics.outcome_success_rate.toFixed(2)}<${p.min_outcome_success}`
    );
  }
  if (metrics.incidents_30d > p.max_incidents_30d)
    missing.push(`incidents ${metrics.incidents_30d}>${p.max_incidents_30d}`);
  return { ready: missing.length === 0, missing };
}

function forcedApproveGate(): AutonomousOpsGateResult {
  let policyVersion = 'unavailable';
  try {
    policyVersion = getAutonomousOpsPolicy().version;
  } catch {
    // keep 'unavailable'
  }
  return {
    actionId: DOT_AUTONOMY_PROMOTION_ACTION_ID,
    decision: 'approve',
    allowed: false,
    score: 0,
    maxScore: 0,
    policyVersion,
    executionMode: 'apply',
    reason: 'dot autonomy promotion always needs a human decision',
    axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
    shadow: false,
    escalations: ['requested'],
    highRiskPathMatches: [],
  };
}

const SETTLED_APPROVED = new Set<ApprovalRequestRecord['status']>(['approved', 'applied']);
const SETTLED_TERMINAL = new Set<ApprovalRequestRecord['status']>([
  'rejected',
  'expired',
  'cancelled',
  'failed',
]);

export interface DotAutonomyStepResult {
  dot_id: string;
  level: DotAutonomyLevel;
  shadow_rows: number;
  change?: { from: DotAutonomyLevel; to: DotAutonomyLevel; reason: string };
  promotion_requested?: { to: DotAutonomyLevel; request_id: string };
  promotion_cleared?: string;
}

/**
 * One autonomy pass for a dot: shadow rows, settle a pending promotion card
 * (applied only for a human approval), automatic demotion, then — once per
 * UTC day — a promotion card when the metrics clear the policy bar.
 */
export function runDotAutonomyStep(
  c: DotCharter,
  deps: DotAutonomyDeps = {}
): DotAutonomyStepResult {
  const now = nowOf(deps);
  const policy = loadDotAutonomyPolicy(deps);
  let state: DotAutonomyStateDoc = readDotAutonomyState(c, deps);
  const firstRun = !(state as { persisted?: boolean }).persisted;
  const shadow = recordDotAutonomyShadow(c, deps).length;
  const result: DotAutonomyStepResult = {
    dot_id: c.dot_id,
    level: state.level,
    shadow_rows: shadow,
  };
  const save = () => writeDotAutonomyState(c, state, deps);
  if (firstRun) {
    // Only events after rollout count toward demotion.
    save();
    return result;
  }

  // 1. settle a pending promotion card opened in an earlier sweep.
  const pending = state.pending_promotion;
  if (pending && Date.parse(pending.requested_at) < now.getTime()) {
    let approval: ApprovalRequestRecord | null = null;
    let readable = true;
    try {
      approval = (
        deps.loadApproval ?? ((id: string) => loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, id))
      )(pending.request_id);
    } catch (error) {
      readable = false;
      logger.warn(
        `promotion card ${pending.request_id} unreadable for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep | evidence: ${dotAutonomyStatePath(c)}`
      );
    }
    if (readable) {
      const human =
        approval?.decidedByType === 'human' && approval.decidedBy !== VETO_WINDOW_DECIDER;
      if (approval && SETTLED_APPROVED.has(approval.status) && human) {
        const target = clampDotAutonomyLevel(c, pending.to);
        const from = state.level;
        if (dotAutonomyLevelRank(target) === dotAutonomyLevelRank(from) + 1) {
          const reason = `promoted from ${from}: approved by ${approval.decidedBy ?? 'operator'}`;
          state = changeLevel(c, state, target, reason, now);
          result.change = { from, to: target, reason };
          audit(
            c,
            'promote',
            { from, to: target, request_id: pending.request_id, decided_by: approval.decidedBy },
            deps
          );
          notify(c, `autonomy ${from} → ${target}`, reason, deps);
        } else {
          const { pending_promotion: _p, ...rest } = state;
          state = rest;
          result.promotion_cleared = `stale promotion to ${pending.to} at ${from}`;
        }
      } else if (
        !approval ||
        SETTLED_TERMINAL.has(approval.status) ||
        SETTLED_APPROVED.has(approval.status)
      ) {
        const why = !approval
          ? 'request missing'
          : SETTLED_APPROVED.has(approval.status)
            ? `approved without a human decider (${approval.decidedByType ?? 'unknown'})`
            : `request ${approval.status}`;
        const { pending_promotion: _p, ...rest } = state;
        state = rest;
        result.promotion_cleared = why;
        audit(
          c,
          'promotion_cleared',
          { to: pending.to, request_id: pending.request_id, reason: why },
          deps
        );
      }
    }
  }

  // 2. automatic demotion.
  if (!result.change) {
    const metrics = dotAutonomyMetrics(c, deps);
    const why = dotAutonomyDemotionReason(metrics, policy);
    const floorLevel = c.autonomy?.min_level ?? DOT_AUTONOMY_DEFAULT_DEMOTION_FLOOR;
    const floorRank = Math.max(
      dotAutonomyLevelRank(floorLevel),
      dotAutonomyLevelRank(dotAutonomyBounds(c).min)
    );
    if (why && dotAutonomyLevelRank(state.level) > floorRank) {
      const from = state.level;
      const to = DOT_AUTONOMY_LEVELS[dotAutonomyLevelRank(from) - 1];
      const reason = `demoted from ${from}: ${why}`;
      state = changeLevel(c, state, to, reason, now);
      result.change = { from, to, reason };
      audit(c, 'demote', { from, to, reason: why }, deps);
      notify(
        c,
        `autonomy ${from} → ${to}`,
        `${reason}. Promotion needs your approval again.`,
        deps
      );
    }
  }

  // 3. daily promotion evaluation.
  const day = now.toISOString().slice(0, 10);
  if (!result.change && !state.pending_promotion && state.last_promotion_check_day !== day) {
    state = { ...state, last_promotion_check_day: day };
    const metrics = dotAutonomyMetrics(c, deps);
    const verdict = dotAutonomyPromotionReady(metrics, policy);
    if (verdict.ready && metrics.next_level) {
      const to = metrics.next_level;
      const actor = `dot:${c.dot_id}`;
      const routed = (deps.route ?? routeAutonomousDecision)({
        role: GOVERNED_STORE_ROLE,
        gate: forcedApproveGate(),
        title: `[${actor}] autonomy ${state.level} → ${to}`,
        question: `Promote ${c.title} from ${state.level} to ${to}?`,
        recommendation: `Over ${DOT_AUTONOMY_METRICS_DAYS} days: ${metrics.decisions} decisions, agreement ${(metrics.agreement_rate * 100).toFixed(0)}%, outcome success ${(metrics.outcome_success_rate * 100).toFixed(0)}%, incidents ${metrics.incidents_30d}.`,
        requestedBy: actor,
        source: { agentId: actor },
        dedupeKey: `dot-autonomy-${c.dot_id}-${to}`,
        notificationRoute: dotNotificationRoute(c),
        quietHours: dotQuietHours(c),
        ...(c.scope.tenant_slug
          ? {
              scope: {
                tenant_slug: c.scope.tenant_slug,
                ...(c.scope.organization_id ? { organization_id: c.scope.organization_id } : {}),
              },
            }
          : {}),
        now: now.getTime(),
      });
      if (routed.requestId) {
        state = {
          ...state,
          pending_promotion: { to, request_id: routed.requestId, requested_at: now.toISOString() },
        };
        result.promotion_requested = { to, request_id: routed.requestId };
        audit(
          c,
          'promotion_requested',
          { from: state.level, to, request_id: routed.requestId },
          deps
        );
      }
    }
  }

  result.level = state.level;
  save();
  return result;
}

/** Supervisor entry: every active dot, each isolated. */
export function runDotAutonomySweep(
  charters: readonly DotCharter[],
  deps: DotAutonomyDeps = {}
): DotAutonomyStepResult[] {
  const results: DotAutonomyStepResult[] = [];
  for (const c of charters) {
    try {
      results.push(runDotAutonomyStep(c, deps));
    } catch (error) {
      logger.warn(
        `autonomy step failed for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep; the level is unchanged | evidence: ${dotAutonomyStatePath(c)}`
      );
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// status + digest sections
// ---------------------------------------------------------------------------

export function dotAutonomyStatusSection(): DotStatusSection {
  return {
    id: 'autonomy',
    collect(c, ctx) {
      const d = { rootDir: ctx.rootDir, now: ctx.now };
      const state = readDotAutonomyState(c, d);
      const bounds = dotAutonomyBounds(c);
      const metrics = dotAutonomyMetrics(c, d);
      return {
        level: state.level,
        since: state.since,
        min_level: bounds.min,
        max_level: bounds.max,
        ...(state.pending_promotion ? { pending_promotion: state.pending_promotion } : {}),
        decisions_30d: metrics.decisions,
        agreement_rate: Number(metrics.agreement_rate.toFixed(3)),
        outcome_success_rate: Number(metrics.outcome_success_rate.toFixed(3)),
        incidents_30d: metrics.incidents_30d,
        rejection_streak: metrics.rejection_streak,
      };
    },
  };
}

export function dotAutonomyDigestLines(
  c: DotCharter,
  since: Date | undefined,
  ctx: DotExtCtx
): string[] {
  const state = readDotAutonomyState(c, { rootDir: ctx.rootDir, now: ctx.now });
  const changes = state.history.filter(
    (entry) => !since || Date.parse(entry.at) >= since.getTime()
  );
  return [
    ...changes.map((entry) => `Autonomy: now ${entry.level} — ${entry.reason}`),
    ...(state.pending_promotion
      ? [`Autonomy: promotion to ${state.pending_promotion.to} is waiting on your decision`]
      : []),
  ];
}

export function dotAutonomyDigestSection(): DotDigestSection {
  return { id: 'autonomy', lines: (c, since, ctx) => dotAutonomyDigestLines(c, since, ctx) };
}
