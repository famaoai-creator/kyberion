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
 *      - `task_session` / `direct_reply` → one bounded goal turn under the
 *        charter role, or — without a live tool backend — one read-only
 *        delegated turn whose effects must be re-proposed;
 *      - `mission` → blocked with guidance: the executor never starts missions;
 *   4. release the item (done; a failure is re-queued until
 *      {@link DOT_EXECUTOR_MAX_ATTEMPTS}; an escalation — blocked, or failed
 *      out of attempts — is released `archived` so it stops holding a
 *      delegation slot, with the real status in `metadata.dot_executor`),
 *      append a {@link DotWorkResultRow}, record an audit-chain entry and wake
 *      the dot with a report-back inbox row (`payload.report_from = 'dot-executor'`).
 *
 * Bounds: every item races the charter wall-clock budget (an AbortSignal is
 * handed to the ports; a timeout fails the item and lease renewal stops), a
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

import * as path from 'node:path';
import { withExecutionContextAsync } from '../authority.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { auditChain } from '../governance/audit-chain.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import {
  claimWorkItem,
  listWorkItems,
  reapExpiredWorkLeases,
  releaseWorkItem,
  renewWorkItemLease,
  updateWorkItem,
  type ReapWorkLeasesOptions,
  type ReapWorkLeasesResult,
} from '../workforce/work-coordination.js';
import type { WorkItem, WorkItemStatus } from '../workforce/work-coordination-types.js';
import { dotBudgetThrottle } from './dot-budget.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';
import type { DotPromptSection, DotStatusSection } from './dot-extensions.js';
import { readDotSignals } from './dot-feedback.js';
import type { DotExtCtx } from './dot-extensions.js';
import { appendDotInboxEntry, type DotInboxEntryInput } from './dot-inbox.js';
import type { DotWorkShape } from './dot-proposals.js';
import {
  DOT_EXECUTOR_REPORT_SOURCE,
  dotDailyTokenCapReached,
  recordDotTokenUsage,
  type DotWakeLoopOptions,
  type DotWakeLoopResult,
} from './dot-runtime.js';
import {
  DOT_KR_LEDGER_FILE,
  DOT_WORK_RESULTS_FILE,
  dotStatePath,
  type DotWorkResultRow,
  type KrMeasurementRow,
} from './dot-state-paths.js';

const logger = createLogger('dot-executor');

/** Wall-clock bound when the charter declares none (same as a delegated wake). */
export const DOT_EXECUTOR_DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;
/** Lease slack beyond the wall-clock budget. */
export const DOT_EXECUTOR_LEASE_SLACK_MS = 60 * 1000;
/** Max characters of a result summary. */
export const DOT_WORK_RESULT_SUMMARY_MAX = 600;
/** A failing item is re-queued until it has been attempted this many times, then escalated. */
export const DOT_EXECUTOR_MAX_ATTEMPTS = 3;
/** Results shown in the wake prompt. */
export const DOT_WORK_RESULTS_PROMPT_LIMIT = 5;
/** A sweep starts no new item once this much wall-clock time has elapsed (wakes must not starve). */
export const DOT_EXECUTOR_SWEEP_BUDGET_MS = 2 * 60 * 1000;
/** WorkItem status an escalated item is released to: terminal, so it frees the delegation slot. */
export const DOT_EXECUTOR_ESCALATED_STATUS: WorkItemStatus = 'archived';
export const DOT_EXECUTOR_READ_ONLY_PREFIX = 'read-only result, effects must be re-proposed: ';
export const DOT_EXECUTOR_CROSS_TENANT_DENIAL =
  'denied: the WorkItem context tenant differs from the executing charter tenant — not claimed';
export const DOT_EXECUTOR_MISSION_GUIDANCE =
  'mission-shaped work needs `mission_controller start` by an operator — the dot executor never starts missions; re-propose as task_session or pipeline, or ask the operator to start a mission';

export type DotGoalMode = 'tool' | 'delegated' | { unavailable: string };

/**
 * Execution ports. Each receives an AbortSignal that fires when the charter's
 * wall-clock budget runs out; the executor stops waiting at that moment either
 * way, so a port that cannot cancel merely runs on unobserved.
 */
export interface DotExecutorPorts {
  /** Bounded goal-driven loop under the charter role (live tool backend). */
  runGoalTurn(
    o: DotWakeLoopOptions,
    signal?: AbortSignal
  ): Promise<DotWakeLoopResult & { finalText?: string }>;
  /** One read-only delegated turn, bounded by `timeoutMs`. */
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

export interface DotExecutorDeps {
  /** Dot state root (results / KR ledger). WorkItems are addressed by the coordination namespace. */
  rootDir?: string;
  now?: () => Date;
  listItems?: () => WorkItem[];
  claim?: typeof claimWorkItem;
  release?: typeof releaseWorkItem;
  renew?: typeof renewWorkItemLease;
  /** Budget port; defaults to the charter-scope governor throttle. */
  throttle?: (c: DotCharter) => 'normal' | 'soft' | 'hard';
  appendInbox?: (input: DotInboxEntryInput) => void;
  audit?: (entry: Parameters<typeof auditChain.record>[0]) => void;
  recordTokens?: (dotId: string, tokens: number) => void;
  /** Lease renewal period; defaults to a third of the lease TTL (min 30 s). */
  renewIntervalMs?: number;
  /** The dot's own daily token cap check; defaults to {@link dotDailyTokenCapReached}. */
  tokenCapReached?: (c: DotCharter) => boolean;
  /** Stranded-claim reaper; defaults to {@link reapExpiredWorkLeases}. */
  reap?: (options: ReapWorkLeasesOptions) => ReapWorkLeasesResult;
  /** WorkItem update port (archives reaper-parked items); defaults to {@link updateWorkItem}. */
  update?: typeof updateWorkItem;
  /** Elapsed-time clock in ms (wall-clock bounds); defaults to `Date.now`. */
  clock?: () => number;
  /** Per-sweep budget; defaults to {@link DOT_EXECUTOR_SWEEP_BUDGET_MS}. */
  sweepBudgetMs?: number;
}

export type DotExecutorPortsInput = DotExecutorPorts | ((c: DotCharter) => DotExecutorPorts);

function nowOf(deps: DotExecutorDeps): Date {
  return deps.now?.() ?? new Date();
}

function stateFile(deps: DotExecutorDeps, rel: string): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), rel);
}

function actorOf(c: DotCharter): string {
  return `dot:${c.dot_id}`;
}

function bounded(text: string, max = DOT_WORK_RESULT_SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function meta(item: WorkItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function wallClockMs(c: DotCharter): number {
  return c.goal.budget?.wall_clock_ms_per_wake ?? DOT_EXECUTOR_DEFAULT_WALL_CLOCK_MS;
}

/** True when this charter's executor works the item (its own, or handed to it). */
function addressedTo(c: DotCharter, item: WorkItem): boolean {
  const handoffTo = meta(item, 'handoff_to');
  if (handoffTo) return handoffTo === c.dot_id;
  return meta(item, 'dot_id') === c.dot_id;
}

/** Ready, unleased WorkItems this dot's executor may claim, oldest first. */
export function listClaimableDotWorkItems(c: DotCharter, deps: DotExecutorDeps = {}): WorkItem[] {
  const items = deps.listItems ? deps.listItems() : listWorkItems({ status: ['ready'] });
  return items
    .filter((item) => item.status === 'ready' && !item.lease_id && addressedTo(c, item))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.item_id.localeCompare(b.item_id));
}

/** Latest measured value per key result for this dot; absent ledger → undefined. */
export function readDotKrSnapshot(
  c: DotCharter,
  deps: DotExecutorDeps = {}
): Record<string, number> | undefined {
  let rows: KrMeasurementRow[];
  try {
    rows = readJsonLines<KrMeasurementRow>(stateFile(deps, dotStatePath(c, DOT_KR_LEDGER_FILE)), {
      onMalformed: 'skip',
    });
  } catch {
    return undefined;
  }
  const latest = new Map<string, { at: string; value: number }>();
  for (const row of rows) {
    if (!row || typeof row.kr_id !== 'string' || !Number.isFinite(row.value)) continue;
    if (row.scope === 'org' || (row.dot_id !== undefined && row.dot_id !== c.dot_id)) continue;
    const at = String(row.measured_at ?? '');
    const prev = latest.get(row.kr_id);
    if (!prev || at >= prev.at) latest.set(row.kr_id, { at, value: row.value });
  }
  if (latest.size === 0) return undefined;
  return Object.fromEntries([...latest].map(([kr, entry]) => [kr, entry.value]));
}

/** Latest health (1 healthy / 0) per signal this dot measured; absent ledger → undefined. */
export function readDotSignalSnapshot(
  c: DotCharter,
  deps: DotExecutorDeps = {}
): Record<string, 0 | 1> | undefined {
  let rows: ReturnType<typeof readDotSignals>;
  try {
    rows = readDotSignals(c.dot_id, { rootDir: deps.rootDir });
  } catch {
    return undefined;
  }
  const latest = new Map<string, { at: string; healthy: boolean }>();
  for (const row of rows) {
    const at = String(row.measured_at ?? '');
    const prev = latest.get(row.signal);
    if (!prev || at >= prev.at) latest.set(row.signal, { at, healthy: Boolean(row.healthy) });
  }
  if (latest.size === 0) return undefined;
  return Object.fromEntries(
    [...latest].map(([signal, entry]) => [signal, entry.healthy ? 1 : 0] as const)
  );
}

/** This dot's recorded work results, oldest first. */
export function readDotWorkResults(c: DotCharter, deps: DotExecutorDeps = {}): DotWorkResultRow[] {
  return readJsonLines<DotWorkResultRow>(stateFile(deps, dotStatePath(c, DOT_WORK_RESULTS_FILE)), {
    onMalformed: 'skip',
  }).filter((row) => row?.dot_id === c.dot_id && typeof row.work_item_id === 'string');
}

function appendWorkResult(c: DotCharter, row: DotWorkResultRow, deps: DotExecutorDeps): void {
  const file = stateFile(deps, dotStatePath(c, DOT_WORK_RESULTS_FILE));
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, row);
}

/** Wake-prompt lines: the last few results of the dot's delegated work. */
export function dotWorkResultsPromptLines(c: DotCharter, ctx: DotExtCtx): string[] {
  const rows = readDotWorkResults(c, { rootDir: ctx.rootDir }).slice(
    -DOT_WORK_RESULTS_PROMPT_LIMIT
  );
  if (rows.length === 0) return [];
  return [
    'Results of your delegated work (newest last; build on them, do not re-propose finished work):',
    ...rows.map(
      (row) =>
        `- [${row.status}] ${row.action_ref} (${row.mode}, ${row.completed_at}): ${bounded(row.summary, 200)}`
    ),
  ];
}

/**
 * Prompt section factory, registered by `dot-extension-bootstrap.ts`.
 */
export function dotWorkResultsPromptSection(): DotPromptSection {
  return {
    id: 'dot-work-results',
    order: 40,
    lines: (c, ctx) => dotWorkResultsPromptLines(c, ctx),
  };
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
}

async function routeItem(
  c: DotCharter,
  item: WorkItem,
  ports: DotExecutorPorts,
  goalMode: DotGoalMode,
  signal: AbortSignal
): Promise<Outcome> {
  const shape = (meta(item, 'requested_work_shape') ?? 'task_session') as DotWorkShape;
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
  const budget = c.goal.budget;
  if (goalMode === 'delegated') {
    const prompt = `${executorSystemPrompt(c, true)}\n\n${executorObjective(item)}`;
    const text = await ports.delegateText(prompt, wallClockMs(c), signal);
    return {
      mode: 'delegated',
      status: 'done',
      summary: `${DOT_EXECUTOR_READ_ONLY_PREFIX}${text}`,
      tokens: Math.ceil((prompt.length + text.length) / 3),
    };
  }
  const result = await ports.runGoalTurn(
    {
      objective: executorObjective(item),
      goalId: `dot-exec-${item.item_id}`,
      systemPrompt: executorSystemPrompt(c, false),
      toolRole: c.authority.authority_role,
      ...(budget?.max_turns_per_wake !== undefined ? { maxTurns: budget.max_turns_per_wake } : {}),
      budget: {
        wallClockBudgetMs: wallClockMs(c),
        ...(budget?.max_turns_per_wake !== undefined
          ? { turnBudget: budget.max_turns_per_wake }
          : {}),
      },
    },
    signal
  );
  const report = result.finalText?.trim();
  const state = result.finalState ?? 'paused';
  const status: Outcome['status'] =
    state === 'complete' ? 'done' : state === 'blocked' ? 'blocked' : 'failed';
  return {
    mode: 'goal_turn',
    status,
    summary:
      report ||
      (status === 'done'
        ? `goal complete in ${result.turnsRun} turn(s)`
        : `goal ${state} after ${result.turnsRun} turn(s)`),
    tokens: result.goal.budgetStats?.tokensUsed,
  };
}

function recordAudit(
  c: DotCharter,
  result: 'completed' | 'failed' | 'denied',
  metadata: Record<string, unknown>,
  deps: DotExecutorDeps
): void {
  const actor = actorOf(c);
  try {
    (deps.audit ?? ((entry) => auditChain.record(entry)))({
      agentId: actor,
      actor: { kind: 'agent', id: actor, display_name: c.title },
      action: 'dot_action',
      operation: 'dot_work_item_execute',
      result,
      metadata: { dot_id: c.dot_id, authority_role: c.authority.authority_role, ...metadata },
      ...(c.scope.tenant_slug ? { tenantSlug: c.scope.tenant_slug } : {}),
    });
  } catch (error) {
    logger.warn(
      `audit write failed for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: the work-results ledger still records the item | evidence: ${dotStatePath(c, DOT_WORK_RESULTS_FILE)}`
    );
  }
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

/** True when the item's context tenant differs from the executing charter's tenant. */
export function dotItemTenantMismatch(c: DotCharter, item: WorkItem): boolean {
  const itemTenant = item.context?.tenant_slug || undefined;
  const charterTenant = c.scope.tenant_slug || undefined;
  return itemTenant !== charterTenant;
}

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
  const shape = meta(item, 'requested_work_shape') ?? 'task_session';
  const goalMode: DotGoalMode =
    shape === 'task_session' || shape === 'direct_reply' ? (ports.goalMode?.(c) ?? 'tool') : 'tool';
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
      const summary = `exceeded wall_clock budget ${budgetMs}ms — abandoned (the port was signalled to abort)`;
      controller.abort(new Error(summary));
      resolve({ mode: failedMode, status: 'failed', summary });
    }, budgetMs);
  });
  let outcome: Outcome;
  try {
    outcome = await Promise.race([
      routeItem(c, item, ports, goalMode, controller.signal).catch((error): Outcome => ({
        mode: failedMode,
        status: 'failed',
        summary: error instanceof Error ? error.message : String(error),
      })),
      deadline,
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    clearInterval(renewTimer);
  }

  const attempts = claimed.item.attempts?.length ?? 1;
  const retry = outcome.status === 'failed' && attempts < DOT_EXECUTOR_MAX_ATTEMPTS;
  // Escalations end terminal (archived) so they stop holding a delegation slot;
  // the real status lives in metadata.dot_executor, the result row and the report.
  const escalated = outcome.status !== 'done' && !retry;
  const nextStatus: WorkItemStatus =
    outcome.status === 'done' ? 'done' : retry ? 'ready' : DOT_EXECUTOR_ESCALATED_STATUS;
  const summary = bounded(outcome.summary);
  const tenantBound = Boolean(c.scope.tenant_slug);
  const completedAt = nowOf(deps).toISOString();
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
        },
      },
    });
  } catch (error) {
    logger.warn(
      `release failed for ${item.item_id} — ${error instanceof Error ? error.message : String(error)} | next: the lease expires and the reaper returns the item | evidence: ${lease.lease_id}`
    );
  }

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
    ...(outcome.tokens !== undefined && outcome.tokens > 0 ? { tokens_used: outcome.tokens } : {}),
    ...(krSnapshot ? { kr_snapshot: krSnapshot } : {}),
    ...(signalSnapshot ? { signal_snapshot: signalSnapshot } : {}),
  };
  appendWorkResult(c, row, deps);
  if (row.tokens_used) {
    try {
      (
        deps.recordTokens ??
        ((dotId: string, tokens: number) =>
          recordDotTokenUsage(dotId, tokens, { rootDir: deps.rootDir, now: deps.now }))
      )(c.dot_id, row.tokens_used);
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
  // A re-queued failure retries silently; terminal results wake the dot that asked.
  if (!retry) {
    const reportTo = meta(item, 'dot_id') ?? c.dot_id;
    try {
      (
        deps.appendInbox ??
        ((input: DotInboxEntryInput) =>
          void appendDotInboxEntry(input, { rootDir: deps.rootDir, now: deps.now }))
      )({
        dot_id: reportTo,
        channel: 'inbox',
        source: DOT_EXECUTOR_REPORT_SOURCE,
        text: `${
          tenantBound
            ? `WorkItem ${item.item_id} ${outcome.status}`
            : `WorkItem ${item.item_id} ${outcome.status}: ${bounded(item.title, 120)}`
        }${escalated ? ' — escalated: re-propose differently or ask the operator' : ''}`,
        payload: {
          report_from: DOT_EXECUTOR_REPORT_SOURCE,
          work_item_id: item.item_id,
          action_ref: actionRef,
          status: outcome.status,
          mode: outcome.mode,
          ...(escalated ? { escalated: true } : {}),
          ...(reportTo !== c.dot_id ? { executed_by: c.dot_id } : {}),
        },
      });
    } catch (error) {
      logger.warn(
        `report-back failed for ${reportTo} — ${error instanceof Error ? error.message : String(error)} | next: the result is still in the work-results ledger | evidence: ${dotStatePath(c, DOT_WORK_RESULTS_FILE)}`
      );
    }
  }
  return row;
}

const isDotItem = (item: WorkItem): boolean =>
  typeof item.metadata?.dot_id === 'string' && item.metadata.dot_id.length > 0;

/**
 * Crash recovery: reset dot WorkItems stranded `in_progress` by an executor
 * that died mid-item (lease expired or absent) back to `ready`. An item the
 * reaper parks after {@link DOT_EXECUTOR_MAX_ATTEMPTS} lapsed attempts is
 * escalated like any other — archived (frees the slot), result row, audit and
 * report-back — when its executing charter is in `active`. Never throws.
 */
export function reapStrandedDotWorkItems(
  active: readonly LoadedDotCharter[],
  deps: DotExecutorDeps = {}
): ReapWorkLeasesResult | undefined {
  let result: ReapWorkLeasesResult;
  try {
    result = (deps.reap ?? reapExpiredWorkLeases)({
      itemFilter: isDotItem,
      maxErrorAttempts: DOT_EXECUTOR_MAX_ATTEMPTS,
    });
  } catch (error) {
    logger.warn(
      `dot work reaper failed — ${error instanceof Error ? error.message : String(error)} | next: stranded items wait for the next sweep | evidence: work-coordination store`
    );
    return undefined;
  }
  for (const item of result.recovered) {
    logger.info(`reaped stranded dot WorkItem ${item.item_id} back to ready`);
  }
  for (const item of result.parked) {
    const executor = active.find(({ charter }) => addressedTo(charter, item))?.charter;
    try {
      (deps.update ?? updateWorkItem)({
        itemId: item.item_id,
        expectedVersion: item.version,
        status: DOT_EXECUTOR_ESCALATED_STATUS,
        metadata: {
          dot_executor: {
            status: 'failed',
            mode: 'escalated',
            escalated: true,
            completed_at: nowOf(deps).toISOString(),
            reason: 'executor crashed or timed out on every attempt',
          },
        },
      });
    } catch (error) {
      logger.warn(
        `archiving reaper-parked item ${item.item_id} failed — ${error instanceof Error ? error.message : String(error)} | next: it stays blocked and counts toward the delegation cap until an operator closes it | evidence: ${item.item_id}`
      );
      continue;
    }
    if (!executor) continue;
    const at = nowOf(deps).toISOString();
    const row: DotWorkResultRow = {
      dot_id: executor.dot_id,
      work_item_id: item.item_id,
      action_ref: meta(item, 'action_ref') ?? item.item_id,
      mode: 'escalated',
      status: 'failed',
      summary: `abandoned after ${item.attempts?.length ?? DOT_EXECUTOR_MAX_ATTEMPTS} attempt(s) that never released (executor crash or timeout) — re-propose a smaller step`,
      started_at: at,
      completed_at: at,
    };
    try {
      appendWorkResult(executor, row, deps);
    } catch (error) {
      logger.warn(
        `result write failed for reaped ${item.item_id} — ${error instanceof Error ? error.message : String(error)} | next: the archive and audit still record it | evidence: ${dotStatePath(executor, DOT_WORK_RESULTS_FILE)}`
      );
    }
    recordAudit(
      executor,
      'failed',
      {
        work_item_id: item.item_id,
        action_ref: row.action_ref,
        mode: 'escalated',
        status: 'failed',
        next_status: DOT_EXECUTOR_ESCALATED_STATUS,
        reason: 'reaper_parked',
      },
      deps
    );
    const reportTo = meta(item, 'dot_id') ?? executor.dot_id;
    try {
      (
        deps.appendInbox ??
        ((input: DotInboxEntryInput) =>
          void appendDotInboxEntry(input, { rootDir: deps.rootDir, now: deps.now }))
      )({
        dot_id: reportTo,
        channel: 'inbox',
        source: DOT_EXECUTOR_REPORT_SOURCE,
        text: `WorkItem ${item.item_id} failed — escalated: abandoned after repeated executor crashes`,
        payload: {
          report_from: DOT_EXECUTOR_REPORT_SOURCE,
          work_item_id: item.item_id,
          action_ref: row.action_ref,
          status: 'failed',
          mode: 'escalated',
          escalated: true,
        },
      });
    } catch (error) {
      logger.warn(
        `report-back failed for reaped ${item.item_id} — ${error instanceof Error ? error.message : String(error)} | next: the result row still records it | evidence: ${item.item_id}`
      );
    }
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
  deps: DotExecutorDeps & { maxPerSweep?: number } = {}
): Promise<DotWorkResultRow[]> {
  const rows: DotWorkResultRow[] = [];
  const max = Math.max(0, deps.maxPerSweep ?? 1);
  if (max === 0) return rows;
  const clock = deps.clock ?? Date.now;
  const sweepStart = clock();
  const sweepBudget = deps.sweepBudgetMs ?? DOT_EXECUTOR_SWEEP_BUDGET_MS;
  reapStrandedDotWorkItems(active, deps);
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
