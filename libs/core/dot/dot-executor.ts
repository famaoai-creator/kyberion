/**
 * Dot executor (DL-01) — closes the WorkItems a resident dot delegated.
 *
 * Dispatch turns an allowed proposal into a `ready` WorkItem; before this
 * module nothing ever picked those up, so `max_concurrent_delegations` filled
 * and the dot stalled. Per sweep, for each active dot whose budget scope is
 * not at the hard limit, the executor takes at most one item:
 *
 *   1. claim the oldest ready item addressed to the dot (`claimWorkItem`,
 *      actor `dot:<id>`, idempotency key = the action_ref, lease = the
 *      charter's wall-clock budget + 60 s, renewed during long turns);
 *   2. snapshot the dot's latest key-result values (`kr_snapshot`) and signal
 *      health (`signal_snapshot`) — the "before" of the DL-04 outcome check;
 *   3. route by `requested_work_shape`:
 *      - `pipeline` → runs only a `pipeline_ref` listed in
 *        `charter.authority.allowed_pipelines`, otherwise blocked;
 *      - `direct_reply` → one bounded goal or advisory delegated turn;
 *        advisory restrictions are requested, not uniformly enforced by providers;
 *      - `task_session` → only a configured work port; the live adapter currently
 *        blocks it because governed task tools are not available;
 *      - `mission` → blocked with guidance: the executor never starts missions;
 *   4. persist the result, then release the item (done; uncertain failures
 *      and other escalations are released `archived` so they stop holding a
 *      delegation slot, with the real status in `metadata.dot_executor`),
 *      append a {@link DotWorkResultRow}, record an audit-chain entry and wake
 *      the dot with a report-back inbox row (`payload.report_from = 'dot-executor'`).
 *
 * Bounds: every item races the charter wall-clock budget (an AbortSignal is
 * handed to the ports; a timeout quarantines the item and lease renewal stops), a
 * sweep stops starting new items after {@link DOT_EXECUTOR_SWEEP_BUDGET_MS},
 * a dot at its own daily token cap or its scope's hard budget limit is skipped,
 * and items whose context tenant differs from the executing charter's are
 * denied (audited) without a claim. Before each sweep the executor reaps dot
 * items stranded `in_progress` by a crashed executor (expired / absent lease).
 *
 * Tenant dots: result prose lives only in the tenant-scoped
 * `dotStatePath(...)/work-results.jsonl`; the shared WorkItem store, audit
 * chain and inbox get status and ids only.
 *
 * Domain module: the goal driver, delegated turn and pipeline engine arrive
 * as {@link DotExecutorPorts} (wired in `scripts/dot_executor_step.ts`).
 */

import { randomUUID } from 'node:crypto';
import { withExecutionContextAsync } from '../authority.js';
import { createLogger } from '../logger.js';
import { withUsageAttribution } from '../usage-accounting.js';
import {
  claimWorkItem,
  listWorkItems,
  reapExpiredWorkLeases,
  releaseWorkItem,
  renewWorkItemLease,
  updateWorkItem,
  type ReapWorkLeasesResult,
} from '../workforce/work-coordination.js';
import type { WorkItem, WorkItemStatus } from '../workforce/work-coordination-types.js';
import { dotBudgetThrottle } from './dot-budget.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';
import type { DotStatusSection } from './dot-extensions.js';
import { DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE, type DotWorkShape } from './dot-proposals.js';
import {
  dotDailyTokenCapReached,
  recordDotTokenUsage,
  type DotWakeLoopOptions,
  type DotWakeLoopResult,
} from './dot-runtime.js';
import { DOT_WORK_RESULTS_FILE, dotStatePath, type DotWorkResultRow } from './dot-state-paths.js';
import {
  activeTerminalResult,
  actorOf,
  addressedTo,
  appendWorkResult,
  attemptsSinceRelease,
  bounded,
  dotItemTenantMismatch,
  enqueueExecutorReport,
  hasUncertainAttempt,
  meta,
  nowOf,
  operatorVerification,
  readDotKrSnapshot,
  readDotSignalSnapshot,
  readDotWorkResults,
  reconcileExecutorReports,
  recordAudit,
  resultMatchesAttempt,
  terminalWorkResults,
  type DotExecutorDeps,
} from './dot-executor-reports.js';
import { applyApprovedDotReleases } from './dot-executor-release.js';

export {
  DOT_WORK_RESULT_SUMMARY_MAX,
  DOT_WORK_RESULTS_PROMPT_LIMIT,
  dotItemTenantMismatch,
  dotWorkResultsPromptLines,
  dotWorkResultsPromptSection,
  readDotKrSnapshot,
  readDotSignalSnapshot,
  readDotWorkResults,
  type DotExecutorDeps,
  type DotOperatorVerification,
} from './dot-executor-reports.js';
export {
  applyApprovedDotReleases,
  DOT_OPERATOR_RELEASE_OPERATION,
  DOT_RELEASE_ACTION_ID,
  DOT_RELEASE_CORRELATION_PREFIX,
  DOT_RELEASE_EXPIRY_MINUTES,
  requestDotWorkItemRelease,
  type DotReleaseApprovalPorts,
  type DotReleaseRequestResult,
  type RequestDotWorkItemReleaseDeps,
  type RequestDotWorkItemReleaseInput,
} from './dot-executor-release.js';

const logger = createLogger('dot-executor');

/** Wall-clock bound when the charter declares none (same as a delegated wake). */
export const DOT_EXECUTOR_DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;
/** Lease slack beyond the wall-clock budget. */
export const DOT_EXECUTOR_LEASE_SLACK_MS = 60 * 1000;
/** Legacy stranded claims are parked by the coordination reaper at this limit. */
export const DOT_EXECUTOR_MAX_ATTEMPTS = 3;
/** A sweep starts no new item once this much wall-clock time has elapsed (wakes must not starve). */
export const DOT_EXECUTOR_SWEEP_BUDGET_MS = 2 * 60 * 1000;
/** WorkItem status an escalated item is released to: terminal, so it frees the delegation slot. */
export const DOT_EXECUTOR_ESCALATED_STATUS: WorkItemStatus = 'archived';
/** Legacy name denotes the requested behavior, not a provider-wide sandbox guarantee. */
export const DOT_EXECUTOR_READ_ONLY_PREFIX = 'advisory result, effects are unverified: ';
export const DOT_EXECUTOR_CROSS_TENANT_DENIAL =
  'denied: the WorkItem context tenant differs from the executing charter tenant — not claimed';
export const DOT_EXECUTOR_MISSION_GUIDANCE =
  'mission-shaped work needs `mission_controller start` by an operator — the dot executor never starts missions; re-propose as a pipeline from your allowed_pipelines or an advisory direct_reply, or ask the operator to start a mission';
export const DOT_EXECUTOR_TASK_SESSION_GUIDANCE = DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE;
export const DOT_EXECUTOR_MISSING_SHAPE_GUIDANCE =
  'WorkItem has no requested_work_shape — the dot re-proposes with a shape its charter allows';

export type DotGoalMode = 'tool' | 'delegated' | { unavailable: string };

/**
 * Thrown by a port when it failed before it could cause any effect (no backend
 * resolved, pipeline missing or invalid, goal driver threw before its first
 * model call). The executor treats it as a retryable failure, not a quarantine.
 */
export class DotExecutorPreEffectError extends Error {
  readonly preEffect = true;
  constructor(message: string) {
    super(message);
    this.name = 'DotExecutorPreEffectError';
  }
}

/** Duck-typed so a second module instance (src vs dist) still classifies it. */
export function isDotExecutorPreEffectError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { preEffect?: unknown }).preEffect === true
  );
}

/**
 * Execution ports. Each receives an AbortSignal that fires when the charter's
 * wall-clock budget runs out; the executor stops waiting at that moment either
 * way. A timeout is quarantined because signalling abort does not prove the
 * port stopped or that it produced no effects.
 */
export interface DotExecutorPorts {
  /** A production adapter without governed work tools must declare this limitation. */
  taskSessionUnavailable?: string;
  /** Bounded goal-driven loop under the charter role (live tool backend). */
  runGoalTurn(
    o: DotWakeLoopOptions,
    signal?: AbortSignal
  ): Promise<DotWakeLoopResult & { finalText?: string }>;
  /** One advisory delegated turn, bounded by `timeoutMs`; no uniform no-effect guarantee. */
  delegateText(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
  /** Run an allowed pipeline in-process. */
  runPipeline(
    ref: string,
    ctx: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ status: 'succeeded' | 'failed'; summary: string }>;
  /**
   * How conversational work runs for this charter now; defaults to `tool`.
   * `unavailable` leaves the item unclaimed for a later sweep.
   */
  goalMode?(c: DotCharter): DotGoalMode;
}

export type DotExecutorPortsInput = DotExecutorPorts | ((c: DotCharter) => DotExecutorPorts);

function wallClockMs(c: DotCharter): number {
  return c.goal.budget?.wall_clock_ms_per_wake ?? DOT_EXECUTOR_DEFAULT_WALL_CLOCK_MS;
}

/** True when this charter's executor works the item (its own, or handed to it). */
export function listClaimableDotWorkItems(c: DotCharter, deps: DotExecutorDeps = {}): WorkItem[] {
  const items = deps.listItems ? deps.listItems() : listWorkItems({ status: ['ready'] });
  const terminal = terminalWorkResults(c, deps);
  return items
    .filter(
      (item) =>
        item.status === 'ready' &&
        !item.lease_id &&
        addressedTo(c, item) &&
        !activeTerminalResult(terminal, item) &&
        !hasUncertainAttempt(item)
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.item_id.localeCompare(b.item_id));
}

function executorSystemPrompt(c: DotCharter, readOnly: boolean): string {
  return [
    `You are the executor for resident dot "${c.dot_id}" (actor id ${actorOf(c)}), completing ONE delegated WorkItem under role ${c.authority.authority_role}.`,
    `Dot purpose: ${c.purpose}`,
    'Stay inside the role write scopes. Never start a mission, create WorkItems, edit dot charters, or touch another tenant.',
    readOnly
      ? 'You run read-only: investigate and answer; describe concrete changes instead of making them — the dot re-proposes any effect.'
      : 'Do the work, verify it, then mark the goal complete (or blocked with the reason).',
    'End with a short plain-text report: what you did, what changed, and anything left open.',
  ].join('\n');
}

function executorObjective(item: WorkItem): string {
  const lines = [`WorkItem ${item.item_id}: ${item.title}`, '', item.description];
  const target = meta(item, 'target');
  const intent = meta(item, 'intent');
  if (target || intent) {
    lines.push('', `Target: ${target ?? 'n/a'}; intent: ${intent ?? 'n/a'}`);
  }
  const effect = item.metadata?.expected_effect as
    { kr_id?: string; signal?: string; direction?: string } | undefined;
  if (effect && typeof effect === 'object') {
    lines.push(
      `Expected effect: ${effect.direction ?? 'move'} ${effect.kr_id ?? effect.signal ?? ''}`.trim()
    );
  }
  return lines.join('\n');
}

interface Outcome {
  mode: DotWorkResultRow['mode'];
  status: 'done' | 'blocked' | 'failed';
  summary: string;
  tokens?: number;
  reason_code?: DotWorkResultRow['reason_code'];
}

async function routeItem(
  c: DotCharter,
  item: WorkItem,
  ports: DotExecutorPorts,
  goalMode: DotGoalMode,
  signal: AbortSignal,
  accountingId: string
): Promise<Outcome> {
  const shape = meta(item, 'requested_work_shape') as DotWorkShape | undefined;
  if (!shape) {
    return { mode: 'escalated', status: 'blocked', summary: DOT_EXECUTOR_MISSING_SHAPE_GUIDANCE };
  }
  if (shape === 'mission') {
    return { mode: 'escalated', status: 'blocked', summary: DOT_EXECUTOR_MISSION_GUIDANCE };
  }
  if (shape === 'pipeline') {
    const ref = meta(item, 'pipeline_ref');
    const allowed = c.authority.allowed_pipelines ?? [];
    if (!ref || !allowed.includes(ref)) {
      return {
        mode: 'escalated',
        status: 'blocked',
        summary: ref
          ? `pipeline '${ref}' is not in charter authority.allowed_pipelines — the operator must add it to the charter, or the dot re-proposes another shape`
          : 'pipeline-shaped work without pipeline_ref — the dot must re-propose with pipeline_ref',
      };
    }
    const result = await ports.runPipeline(
      ref,
      {
        dot_id: c.dot_id,
        actor_id: actorOf(c),
        work_item_id: item.item_id,
        action_ref: meta(item, 'action_ref'),
        ...(c.scope.tenant_slug ? { tenant_slug: c.scope.tenant_slug } : {}),
        ...(c.scope.organization_id ? { organization_id: c.scope.organization_id } : {}),
        ...(meta(item, 'target') ? { target: meta(item, 'target') } : {}),
        ...(meta(item, 'intent') ? { intent: meta(item, 'intent') } : {}),
      },
      signal
    );
    return {
      mode: 'pipeline',
      status: result.status === 'succeeded' ? 'done' : 'failed',
      summary: `pipeline ${ref} ${result.status}: ${result.summary}`,
    };
  }
  if (shape !== 'task_session' && shape !== 'direct_reply') {
    return {
      mode: 'escalated',
      status: 'blocked',
      summary: `unknown requested_work_shape '${shape}'`,
    };
  }
  if (shape === 'task_session' && (ports.taskSessionUnavailable || goalMode === 'delegated')) {
    return {
      mode: 'escalated',
      status: 'blocked',
      summary: ports.taskSessionUnavailable ?? DOT_EXECUTOR_TASK_SESSION_GUIDANCE,
      reason_code: 'capability_unavailable',
    };
  }
  const budget = c.goal.budget;
  // Only these branches return usage to the dot token ledger. Pipeline usage
  // remains provider-metered, so tagging it as dot-owned would hide its tokens.
  const withDotUsage = <T>(fn: () => Promise<T>): Promise<T> =>
    withUsageAttribution({ actor_id: actorOf(c), scope: c.scope, accounting_id: accountingId }, fn);
  if (goalMode === 'delegated') {
    const prompt = `${executorSystemPrompt(c, true)}\n\n${executorObjective(item)}`;
    const text = await withDotUsage(() => ports.delegateText(prompt, wallClockMs(c), signal));
    return {
      mode: 'delegated',
      status: 'done',
      summary: `${DOT_EXECUTOR_READ_ONLY_PREFIX}${text}`,
      tokens: Math.ceil((prompt.length + text.length) / 3),
    };
  }
  const result = await withDotUsage(() =>
    ports.runGoalTurn(
      {
        objective: executorObjective(item),
        goalId: `dot-exec-${item.item_id}`,
        systemPrompt: executorSystemPrompt(c, shape === 'direct_reply'),
        toolRole: c.authority.authority_role,
        ...(budget?.max_turns_per_wake !== undefined
          ? { maxTurns: budget.max_turns_per_wake }
          : {}),
        budget: {
          wallClockBudgetMs: wallClockMs(c),
          ...(budget?.max_turns_per_wake !== undefined
            ? { turnBudget: budget.max_turns_per_wake }
            : {}),
        },
      },
      signal
    )
  );
  const report = result.finalText?.trim();
  const state = result.finalState ?? 'paused';
  const status: Outcome['status'] =
    state === 'complete' ? 'done' : state === 'blocked' ? 'blocked' : 'failed';
  return {
    mode: 'goal_turn',
    status,
    summary:
      (shape === 'direct_reply' ? DOT_EXECUTOR_READ_ONLY_PREFIX : '') +
      (report ||
        (status === 'done'
          ? `goal complete in ${result.turnsRun} turn(s)`
          : `goal ${state} after ${result.turnsRun} turn(s)`)),
    tokens: result.goal.budgetStats?.tokensUsed,
  };
}

function skippedRow(
  c: DotCharter,
  item: WorkItem,
  startedAt: string,
  reason: string,
  deps: DotExecutorDeps
): DotWorkResultRow {
  return {
    dot_id: c.dot_id,
    work_item_id: item.item_id,
    action_ref: meta(item, 'action_ref') ?? item.item_id,
    mode: 'escalated',
    status: 'skipped',
    summary: bounded(reason),
    started_at: startedAt,
    completed_at: nowOf(deps).toISOString(),
  };
}

/** Items already audited as cross-tenant denials in this process (audit once, not every sweep). */
const deniedAudited = new Set<string>();

/**
 * Tenant re-check before any claim (handed-off items included): deny and
 * audit once when the item belongs to another tenant scope. The audit carries
 * only whether the item was tenant-bound — never the other tenant's slug.
 */
function denyCrossTenantItem(c: DotCharter, item: WorkItem, deps: DotExecutorDeps): boolean {
  if (!dotItemTenantMismatch(c, item)) return false;
  const key = `${c.dot_id}\u0000${item.item_id}`;
  if (!deniedAudited.has(key)) {
    deniedAudited.add(key);
    recordAudit(
      c,
      'denied',
      {
        work_item_id: item.item_id,
        action_ref: meta(item, 'action_ref') ?? item.item_id,
        reason: 'cross_tenant_work_item',
        item_tenant_bound: Boolean(item.context?.tenant_slug),
      },
      deps
    );
    logger.warn(
      `cross-tenant WorkItem refused for ${c.dot_id} — ${item.item_id} is scoped to a different tenant than the charter | next: the item stays unclaimed; an operator re-addresses or cancels it | evidence: ${item.item_id}`
    );
  }
  return true;
}

/** Test hook: forget which cross-tenant denials were already audited. */
export function resetDotExecutorDenialAuditForTests(): void {
  deniedAudited.clear();
}

/**
 * Claim, run and close one WorkItem for this dot. Returns a `skipped` row
 * (not persisted) when the item could not be claimed or no backend can run it.
 */
export async function executeDotWorkItem(
  c: DotCharter,
  item: WorkItem,
  ports: DotExecutorPorts,
  deps: DotExecutorDeps = {}
): Promise<DotWorkResultRow> {
  const startedAt = nowOf(deps).toISOString();
  const actionRef = meta(item, 'action_ref') ?? item.item_id;
  const actor = actorOf(c);
  if (denyCrossTenantItem(c, item, deps)) {
    return skippedRow(c, item, startedAt, DOT_EXECUTOR_CROSS_TENANT_DENIAL, deps);
  }
  if (activeTerminalResult(terminalWorkResults(c, deps), item) || hasUncertainAttempt(item)) {
    return skippedRow(
      c,
      item,
      startedAt,
      'terminal or uncertain execution evidence exists — automatic replay refused',
      deps
    );
  }
  const shape = meta(item, 'requested_work_shape');
  // A task_session the ports cannot run is closed as blocked without probing a backend.
  const conversational =
    shape === 'direct_reply' || (shape === 'task_session' && !ports.taskSessionUnavailable);
  const goalMode: DotGoalMode = conversational ? (ports.goalMode?.(c) ?? 'tool') : 'tool';
  if (typeof goalMode === 'object') {
    return skippedRow(c, item, startedAt, `no backend: ${goalMode.unavailable}`, deps);
  }
  const krSnapshot = readDotKrSnapshot(c, deps);
  const signalSnapshot = readDotSignalSnapshot(c, deps);
  const ttlMs = wallClockMs(c) + DOT_EXECUTOR_LEASE_SLACK_MS;
  let claimed: ReturnType<typeof claimWorkItem>;
  try {
    claimed = (deps.claim ?? claimWorkItem)({
      itemId: item.item_id,
      actorPeerId: actor,
      purpose: 'dot executor',
      ttlMs,
      idempotencyKey: actionRef,
      expectedVersion: item.version,
      metadata: { dot_id: c.dot_id, action_ref: actionRef },
    });
  } catch (error) {
    return skippedRow(
      c,
      item,
      startedAt,
      `claim failed: ${error instanceof Error ? error.message : String(error)}`,
      deps
    );
  }
  const { lease } = claimed;
  const accountingId = claimed.item.current_attempt_id ?? randomUUID();
  const clock = deps.clock ?? Date.now;
  const budgetMs = wallClockMs(c);
  const deadlineAt = clock() + budgetMs;
  const renewEvery = deps.renewIntervalMs ?? Math.max(30_000, Math.floor(ttlMs / 3));
  const renewTimer = setInterval(() => {
    // Past the deadline the item is being abandoned: let the lease lapse.
    if (clock() >= deadlineAt) {
      clearInterval(renewTimer);
      return;
    }
    try {
      (deps.renew ?? renewWorkItemLease)({ leaseId: lease.lease_id, ttlMs, actorPeerId: actor });
    } catch (error) {
      logger.warn(
        `lease renewal failed for ${item.item_id} — ${error instanceof Error ? error.message : String(error)} | next: the turn continues; release may conflict if the lease lapsed | evidence: ${lease.lease_id}`
      );
    }
  }, renewEvery);
  renewTimer.unref?.();

  const failedMode: Outcome['mode'] =
    shape === 'pipeline' ? 'pipeline' : goalMode === 'delegated' ? 'delegated' : 'goal_turn';
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    deadlineTimer = setTimeout(() => {
      const summary = `exceeded wall_clock budget ${budgetMs}ms — outcome uncertain; quarantined, do not retry until an operator verifies effects (abort was requested, not confirmed)`;
      // Settle the deadline before abort listeners can reject the work promise.
      resolve({ mode: failedMode, status: 'blocked', summary });
      controller.abort(new Error(summary));
    }, budgetMs);
  });
  let outcome: Outcome;
  try {
    outcome = await Promise.race([
      routeItem(c, item, ports, goalMode, controller.signal, accountingId).catch(
        (error): Outcome => ({
          mode: failedMode,
          status: 'failed',
          summary: error instanceof Error ? error.message : String(error),
          ...(isDotExecutorPreEffectError(error)
            ? { reason_code: 'pre_effect_failure' as const }
            : {}),
        })
      ),
      deadline,
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    clearInterval(renewTimer);
  }

  const preEffect = outcome.status === 'failed' && outcome.reason_code === 'pre_effect_failure';
  // A pre-effect failure goes back to `ready` until the attempt bound; then it
  // ends as an escalated failure — never as an uncertain quarantine.
  const retryable = preEffect && attemptsSinceRelease(claimed.item) < DOT_EXECUTOR_MAX_ATTEMPTS;
  if (preEffect && !retryable) {
    outcome = {
      ...outcome,
      mode: 'escalated',
      summary: `failed before any effect in ${attemptsSinceRelease(claimed.item)} attempt(s) — ${outcome.summary}; fix the cause, then re-propose`,
    };
  } else if (outcome.status === 'failed' && !preEffect) {
    outcome = {
      ...outcome,
      status: 'blocked',
      summary: `outcome uncertain; quarantined because partial effects cannot be ruled out — ${outcome.summary}; an operator must verify effects before retrying`,
    };
  }

  // Escalations end terminal (archived) so they stop holding a delegation slot;
  // the real status lives in metadata.dot_executor, the result row and the report.
  const escalated = outcome.status !== 'done' && !retryable;
  const nextStatus: WorkItemStatus =
    outcome.status === 'done' ? 'done' : retryable ? 'ready' : DOT_EXECUTOR_ESCALATED_STATUS;
  const summary = bounded(outcome.summary);
  const tenantBound = Boolean(c.scope.tenant_slug);
  const completedAt = nowOf(deps).toISOString();
  const row: DotWorkResultRow = {
    dot_id: c.dot_id,
    work_item_id: item.item_id,
    action_ref: actionRef,
    ...(claimed.item.current_attempt_id ? { attempt_id: claimed.item.current_attempt_id } : {}),
    mode: outcome.mode,
    status: outcome.status,
    summary,
    started_at: startedAt,
    completed_at: completedAt,
    report_to_dot_id: meta(item, 'dot_id') ?? c.dot_id,
    ...(outcome.tokens !== undefined && outcome.tokens > 0 ? { tokens_used: outcome.tokens } : {}),
    ...(outcome.reason_code ? { reason_code: outcome.reason_code } : {}),
    ...(krSnapshot ? { kr_snapshot: krSnapshot } : {}),
    ...(signalSnapshot ? { signal_snapshot: signalSnapshot } : {}),
  };
  // Never release before durable evidence exists. If this throws, the expired
  // claim is conservatively quarantined by recovery, not replayed.
  appendWorkResult(c, row, deps);
  try {
    (deps.release ?? releaseWorkItem)({
      itemId: item.item_id,
      leaseId: lease.lease_id,
      actorPeerId: actor,
      nextStatus,
      // The WorkItem store is a shared floor: tenant prose stays in the dot state path.
      summary: tenantBound
        ? `dot executor: ${outcome.status} (${outcome.mode})${escalated ? ', escalated to the dot' : ''}; details in the dot work results`
        : escalated
          ? bounded(`escalated (${outcome.status}): ${summary}`)
          : summary,
      metadata: {
        dot_executor: {
          status: outcome.status,
          mode: outcome.mode,
          completed_at: completedAt,
          ...(escalated ? { escalated: true } : {}),
          ...(retryable ? { retryable: true } : {}),
          ...operatorVerification(item),
        },
      },
    });
  } catch (error) {
    logger.warn(
      `release failed for ${item.item_id} — ${error instanceof Error ? error.message : String(error)} | next: the reaper reconciles durable result evidence before any retry | evidence: ${lease.lease_id}`
    );
  }

  if (row.tokens_used) {
    try {
      (
        deps.recordTokens ??
        ((dotId: string, tokens: number, usageId?: string) =>
          recordDotTokenUsage(dotId, tokens, {
            rootDir: deps.rootDir,
            now: deps.now,
            accounting_id: usageId,
          }))
      )(c.dot_id, row.tokens_used, accountingId);
    } catch (error) {
      logger.warn(
        `token usage write failed for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: the budget undercounts this item | evidence: ${item.item_id}`
      );
    }
  }
  recordAudit(
    c,
    outcome.status === 'done' ? 'completed' : outcome.mode === 'escalated' ? 'denied' : 'failed',
    {
      work_item_id: item.item_id,
      action_ref: actionRef,
      mode: outcome.mode,
      status: outcome.status,
      next_status: nextStatus,
      ...(tenantBound ? {} : { summary: bounded(summary, 200) }),
    },
    deps
  );
  // A retryable pre-effect failure is not a result yet: no report, no wake.
  return retryable ? row : enqueueExecutorReport(c, row, deps, item);
}

const isDotItem = (item: WorkItem): boolean =>
  typeof item.metadata?.dot_id === 'string' && item.metadata.dot_id.length > 0;

/**
 * Crash recovery replays durable completion evidence and quarantines stranded
 * attempts. A read-only label is not proof of no effects from an unobserved
 * provider. Quarantine survives a failed result write or archive: claim
 * filtering also refuses attempts carrying lease_expired.
 */
export function reapStrandedDotWorkItems(
  active: readonly LoadedDotCharter[],
  deps: DotExecutorDeps = {}
): ReapWorkLeasesResult | undefined {
  let result: ReapWorkLeasesResult;
  const evidence = new Map<string, Map<string, DotWorkResultRow>>();
  const executorFor = (item: WorkItem) =>
    active.find(
      ({ charter }) => addressedTo(charter, item) && !dotItemTenantMismatch(charter, item)
    )?.charter;
  try {
    for (const { charter } of active) {
      evidence.set(charter.dot_id, terminalWorkResults(charter, deps));
    }
    result = (deps.reap ?? reapExpiredWorkLeases)({
      itemFilter: isDotItem,
      maxErrorAttempts: DOT_EXECUTOR_MAX_ATTEMPTS,
      completedEvidence: (item) => {
        const executor = executorFor(item);
        const terminal = executor ? evidence.get(executor.dot_id) : undefined;
        const row = terminal ? activeTerminalResult(terminal, item) : undefined;
        return row?.status === 'done' && resultMatchesAttempt(row, item);
      },
    });
  } catch (error) {
    logger.warn(
      `dot work reaper failed — ${error instanceof Error ? error.message : String(error)} | next: stranded items wait for the next sweep | evidence: work-coordination store`
    );
    return undefined;
  }
  // Include previously recovered items so an archive failure can be reconciled
  // on the next sweep. They remain unclaimable in the meantime.
  let pending: WorkItem[];
  try {
    pending = deps.listItems ? deps.listItems() : listWorkItems({ status: ['ready', 'blocked'] });
  } catch (error) {
    logger.warn(
      `dot recovery inventory failed — ${error instanceof Error ? error.message : String(error)} | next: recovered items remain guarded against replay; retry reconciliation next sweep | evidence: work-coordination store`
    );
    pending = [];
  }
  const parkedIds = new Set(result.parked.map((item) => item.item_id));
  const reconcile = new Map(
    [
      ...pending.filter((item) => item.status === 'ready' || item.status === 'blocked'),
      ...result.recovered,
      ...result.parked,
    ].map((item) => [item.item_id, item])
  );
  for (const item of reconcile.values()) {
    const executor = executorFor(item);
    if (!executor) continue;
    const evidenceFor = evidence.get(executor.dot_id);
    const recorded = evidenceFor ? activeTerminalResult(evidenceFor, item) : undefined;
    const terminal = recorded && resultMatchesAttempt(recorded, item) ? recorded : undefined;
    const conflict = Boolean(recorded && !terminal);
    const uncertain = hasUncertainAttempt(item);
    if (!terminal && !conflict && !uncertain && !parkedIds.has(item.item_id)) continue;
    const at = nowOf(deps).toISOString();
    const attemptId = item.current_attempt_id ?? item.attempts?.at(-1)?.run_id;
    const row: DotWorkResultRow = terminal ?? {
      dot_id: executor.dot_id,
      work_item_id: item.item_id,
      action_ref: meta(item, 'action_ref') ?? item.item_id,
      ...(attemptId ? { attempt_id: attemptId } : {}),
      mode: 'escalated',
      status: uncertain || conflict ? 'blocked' : 'failed',
      summary: conflict
        ? 'execution evidence conflicts with this WorkItem action or attempt — quarantined; an operator must reconcile the reused item before re-proposing'
        : uncertain
          ? 'execution outcome uncertain after an expired lease — quarantined; an operator must verify whether effects occurred before re-proposing'
          : `abandoned after ${item.attempts?.length ?? DOT_EXECUTOR_MAX_ATTEMPTS} attempt(s) that never released — ask the operator to investigate`,
      started_at: at,
      completed_at: at,
      report_to_dot_id: meta(item, 'dot_id') ?? executor.dot_id,
    };
    const nextStatus = row.status === 'done' ? 'done' : DOT_EXECUTOR_ESCALATED_STATUS;
    let persisted = Boolean(terminal);
    try {
      // Evidence first. If this write fails, the expired-attempt guard still
      // prevents automatic execution of this recovered item.
      if (!terminal) appendWorkResult(executor, row, deps);
      persisted = true;
      (deps.update ?? updateWorkItem)({
        itemId: item.item_id,
        expectedVersion: item.version,
        status: nextStatus,
        metadata: {
          ...item.metadata,
          dot_executor: {
            status: row.status,
            mode: row.mode,
            ...(row.status !== 'done' ? { escalated: true } : {}),
            completed_at: row.completed_at,
            reason: 'reconciled durable result or quarantined an uncertain execution',
            ...operatorVerification(item),
          },
        },
      });
    } catch (error) {
      logger.warn(
        `reconciling reaped item ${item.item_id} failed — ${error instanceof Error ? error.message : String(error)} | next: automatic replay is refused; an operator verifies effects and closes it | evidence: ${item.item_id}`
      );
      if (persisted) enqueueExecutorReport(executor, row, deps, item);
      continue;
    }
    enqueueExecutorReport(executor, row, deps, item);
    if (terminal) continue;
    recordAudit(
      executor,
      'failed',
      {
        work_item_id: item.item_id,
        action_ref: row.action_ref,
        mode: 'escalated',
        status: row.status,
        next_status: DOT_EXECUTOR_ESCALATED_STATUS,
        reason: 'reaper_parked',
      },
      deps
    );
  }
  return result;
}

/** Recent escalations shown in `dot status`. */
export const DOT_EXECUTOR_STATUS_ESCALATION_LIMIT = 5;

/**
 * `dot status` section: delegated-work totals and the latest escalations
 * (blocked / failed results the dot must re-propose or hand to the operator).
 * A hoisted function for the same import-cycle reason as the prompt section.
 */
export function dotExecutorStatusSection(): DotStatusSection {
  return {
    id: 'executor',
    collect(c, ctx) {
      const rows = readDotWorkResults(c, { rootDir: ctx.rootDir });
      const escalations = rows.filter(
        (row) => row.status === 'blocked' || (row.status === 'failed' && row.mode === 'escalated')
      );
      const byStatus: Record<string, number> = {};
      for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      return {
        results_total: rows.length,
        by_status: byStatus,
        ...(rows.length ? { last_completed_at: rows[rows.length - 1].completed_at } : {}),
        escalations_total: escalations.length,
        recent_escalations: escalations.slice(-DOT_EXECUTOR_STATUS_ESCALATION_LIMIT).map((row) => ({
          work_item_id: row.work_item_id,
          action_ref: row.action_ref,
          status: row.status,
          mode: row.mode,
          completed_at: row.completed_at,
          summary: bounded(row.summary, 160),
        })),
      };
    },
  };
}

function throttleFor(c: DotCharter, deps: DotExecutorDeps): 'normal' | 'soft' | 'hard' {
  if (deps.throttle) return deps.throttle(c);
  return dotBudgetThrottle(c, { rootDir: deps.rootDir, now: deps.now }).throttle;
}

function tokenCapReached(c: DotCharter, deps: DotExecutorDeps): boolean {
  if (deps.tokenCapReached) return deps.tokenCapReached(c);
  return dotDailyTokenCapReached(c, { rootDir: deps.rootDir, now: deps.now });
}

/**
 * One executor pass over the active charters: first reap stranded dot claims,
 * then at most `maxPerSweep` (default 1) item per active, non-paused dot that
 * is neither at its own daily token cap nor at its scope's hard budget limit,
 * each run inside the charter's role and tenant context. Cross-tenant items
 * are denied without counting against the per-dot quota. No new item starts
 * once the sweep has run for `sweepBudgetMs`. Never throws for a single dot.
 */
export async function runDotExecutorSweep(
  active: readonly LoadedDotCharter[],
  ports: DotExecutorPortsInput,
  sweepDeps: DotExecutorDeps & { maxPerSweep?: number } = {}
): Promise<DotWorkResultRow[]> {
  // Read each dot's work results once per sweep; this module keeps the cache current.
  const deps = { ...sweepDeps, resultsCache: sweepDeps.resultsCache ?? new Map() };
  const rows: DotWorkResultRow[] = [];
  const max = Math.max(0, deps.maxPerSweep ?? 1);
  if (max === 0) return rows;
  const clock = deps.clock ?? Date.now;
  const sweepStart = clock();
  const sweepBudget = deps.sweepBudgetMs ?? DOT_EXECUTOR_SWEEP_BUDGET_MS;
  reapStrandedDotWorkItems(active, deps);
  reconcileExecutorReports(active, deps);
  // Human-approved quarantine releases take effect here, before any claim.
  applyApprovedDotReleases(active, deps);
  for (const { charter } of active) {
    if (charter.status !== 'active') continue;
    if (clock() - sweepStart >= sweepBudget) {
      logger.info(
        `executor sweep budget ${sweepBudget}ms spent — remaining dots wait for the next sweep`
      );
      break;
    }
    try {
      let capped = false;
      try {
        capped = tokenCapReached(charter, deps);
      } catch (error) {
        logger.warn(
          `token cap check failed for ${charter.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: the executor proceeds | evidence: active/shared/runtime/dot`
        );
      }
      if (capped) {
        logger.debug(`executor skips ${charter.dot_id}: daily token cap reached`);
        continue;
      }
      let throttle: 'normal' | 'soft' | 'hard';
      try {
        throttle = throttleFor(charter, deps);
      } catch (error) {
        // Fail open: a broken governor must not stop the organization loop.
        logger.warn(
          `budget evaluation failed for ${charter.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: the executor proceeds; check spend-policy.json org_budget | evidence: knowledge/product/governance/spend-policy.json`
        );
        throttle = 'normal';
      }
      if (throttle === 'hard') continue;
      const candidates = listClaimableDotWorkItems(charter, deps).filter(
        (item) => !denyCrossTenantItem(charter, item, deps)
      );
      if (candidates.length === 0) continue;
      const charterPorts = typeof ports === 'function' ? ports(charter) : ports;
      for (const item of candidates.slice(0, max)) {
        if (clock() - sweepStart >= sweepBudget) break;
        const row = await withExecutionContextAsync(
          charter.authority.authority_role,
          () => executeDotWorkItem(charter, item, charterPorts, deps),
          undefined,
          charter.scope.tenant_slug,
          charter.scope.organization_id
        );
        rows.push(row);
      }
    } catch (error) {
      logger.warn(
        `executor pass failed for ${charter.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep | evidence: ${dotStatePath(charter, DOT_WORK_RESULTS_FILE)}`
      );
    }
  }
  return rows;
}
