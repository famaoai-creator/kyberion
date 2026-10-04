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

import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withExecutionContext, withExecutionContextAsync } from '../authority.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { auditChain } from '../governance/audit-chain.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import { withUsageAttribution } from '../usage-accounting.js';
import {
  claimWorkItem,
  getWorkItem,
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
import { DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE, type DotWorkShape } from './dot-proposals.js';
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
/** Legacy stranded claims are parked by the coordination reaper at this limit. */
export const DOT_EXECUTOR_MAX_ATTEMPTS = 3;
/** Results shown in the wake prompt. */
export const DOT_WORK_RESULTS_PROMPT_LIMIT = 5;
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
/** Audit-chain operation of a governed operator release (`pnpm kyberion dot release`). */
export const DOT_OPERATOR_RELEASE_OPERATION = 'dot_work_item_operator_release';
/** libs/core governed stores (WorkItems) write under this shared role, as in dispatch. */
const GOVERNED_STORE_ROLE = 'infrastructure_sentinel';

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
  recordTokens?: (dotId: string, tokens: number, accountingId?: string) => void;
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
  /**
   * Work-results rows per dot, read once per sweep and kept current by this
   * module's own appends/marks. `runDotExecutorSweep` creates one per sweep.
   */
  resultsCache?: Map<string, DotWorkResultRow[]>;
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

function resultsCacheKey(c: DotCharter): string {
  return `${dotStatePath(c, DOT_WORK_RESULTS_FILE)}\u0000${c.dot_id}`;
}

function ownRows(c: DotCharter, rows: DotWorkResultRow[]): DotWorkResultRow[] {
  return rows.filter((row) => row?.dot_id === c.dot_id && typeof row.work_item_id === 'string');
}

function appendWorkResult(c: DotCharter, row: DotWorkResultRow, deps: DotExecutorDeps): void {
  withExecutionContext(
    c.authority.authority_role,
    () => {
      const file = stateFile(deps, dotStatePath(c, DOT_WORK_RESULTS_FILE));
      withLockSync(workResultLock(file), () => {
        safeMkdir(path.dirname(file), { recursive: true });
        appendJsonLine(file, row);
      });
    },
    undefined,
    c.scope.tenant_slug,
    c.scope.organization_id
  );
  deps.resultsCache?.get(resultsCacheKey(c))?.push(row);
}

function workResultLock(file: string): string {
  return `dot-results-${createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 24)}`;
}

function executorReportKey(row: DotWorkResultRow, reportTo: string): string {
  return `dot-executor:${createHash('sha256')
    .update(
      JSON.stringify([
        row.dot_id,
        reportTo,
        row.work_item_id,
        row.action_ref,
        row.attempt_id,
        row.started_at,
        row.completed_at,
        row.status,
      ])
    )
    .digest('hex')}`;
}

/** Mark the existing result atomically, rather than duplicating its tokens/outcomes row. */
function markReportEnqueued(
  c: DotCharter,
  row: DotWorkResultRow,
  reportTo: string,
  deps: DotExecutorDeps,
  suppressed?: DotWorkResultRow['report_suppressed']
): DotWorkResultRow {
  return withExecutionContext(
    c.authority.authority_role,
    () => {
      const file = stateFile(deps, dotStatePath(c, DOT_WORK_RESULTS_FILE));
      return withLockSync(workResultLock(file), () => {
        const rows = readJsonLines<DotWorkResultRow>(file);
        const key = executorReportKey(row, reportTo);
        let marked: DotWorkResultRow | undefined;
        const updated = rows.map((entry) => {
          if (
            entry?.dot_id !== c.dot_id ||
            executorReportKey(entry, entry.report_to_dot_id ?? reportTo) !== key
          )
            return entry;
          marked = {
            ...entry,
            report_to_dot_id: reportTo,
            report_enqueued_at: entry.report_enqueued_at ?? nowOf(deps).toISOString(),
            ...(suppressed ? { report_suppressed: suppressed } : {}),
          };
          return marked;
        });
        if (!marked)
          throw new Error(`result missing while recording report receipt for ${row.work_item_id}`);
        safeWriteFile(file, updated.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
        if (deps.resultsCache?.has(resultsCacheKey(c))) {
          deps.resultsCache.set(resultsCacheKey(c), ownRows(c, updated));
        }
        return marked;
      });
    },
    undefined,
    c.scope.tenant_slug,
    c.scope.organization_id
  );
}

/** Inbox receipt then result marker: either failure is safely retryable without replaying work. */
function enqueueExecutorReport(
  c: DotCharter,
  row: DotWorkResultRow,
  deps: DotExecutorDeps,
  item?: WorkItem
): DotWorkResultRow {
  if (row.report_enqueued_at) return row;
  const reportTo = row.report_to_dot_id ?? (item ? meta(item, 'dot_id') : undefined) ?? c.dot_id;
  const escalated = row.status !== 'done';
  if (row.reason_code === 'capability_unavailable') {
    // Waking the dot for a capability this runtime lacks only invites a
    // reworded re-proposal; it reads the result on its next natural wake.
    try {
      return markReportEnqueued(c, row, reportTo, deps, 'capability_unavailable');
    } catch (error) {
      logger.warn(
        `report receipt pending for ${reportTo} — ${error instanceof Error ? error.message : String(error)} | next: the next sweep retries without waking the dot | evidence: ${dotStatePath(c, DOT_WORK_RESULTS_FILE)}`
      );
      return row;
    }
  }
  const advice =
    row.reason_code === 'pre_effect_failure'
      ? ' — failed before any effect: fix the cause, then re-propose'
      : ' — escalated: ask the operator to verify effects before re-proposing';
  try {
    (
      deps.appendInbox ??
      ((input: DotInboxEntryInput) => {
        appendDotInboxEntry(input, { rootDir: deps.rootDir, now: deps.now });
      })
    )({
      dot_id: reportTo,
      channel: 'inbox',
      source: DOT_EXECUTOR_REPORT_SOURCE,
      idempotency_key: executorReportKey(row, reportTo),
      text: `WorkItem ${row.work_item_id} ${row.status}${!c.scope.tenant_slug && item ? `: ${bounded(item.title, 120)}` : ''}${escalated ? advice : ''}`,
      payload: {
        report_from: DOT_EXECUTOR_REPORT_SOURCE,
        work_item_id: row.work_item_id,
        action_ref: row.action_ref,
        status: row.status,
        mode: row.mode,
        ...(escalated ? { escalated: true } : {}),
        ...(reportTo !== c.dot_id ? { executed_by: c.dot_id } : {}),
      },
    });
    return markReportEnqueued(c, row, reportTo, deps);
  } catch (error) {
    logger.warn(
      `report-back pending for ${reportTo} — ${error instanceof Error ? error.message : String(error)} | next: the next sweep retries the same inbox identity without re-executing work | evidence: ${dotStatePath(c, DOT_WORK_RESULTS_FILE)}`
    );
    return row;
  }
}

/** A released/archived WorkItem still needs a report if its durable receipt marker is absent. */
function reconcileExecutorReports(
  active: readonly LoadedDotCharter[],
  deps: DotExecutorDeps
): void {
  let items: WorkItem[] = [];
  try {
    items = deps.listItems ? deps.listItems() : listWorkItems({});
  } catch {
    /* Saved recipient is sufficient for new results. */
  }
  for (const { charter } of active) {
    try {
      const rows = scopedWorkResults(charter, deps);
      // Rows without report_to_dot_id predate report recovery: their report was
      // delivered inline, so they count as reported (no upgrade storm, no rewrite).
      for (const row of rows.filter(
        (entry) =>
          isTerminalWorkResult(entry) &&
          !entry.report_enqueued_at &&
          Boolean(entry.report_to_dot_id)
      )) {
        const item = items.find(
          (entry) => entry.item_id === row.work_item_id && !dotItemTenantMismatch(charter, entry)
        );
        enqueueExecutorReport(charter, row, deps, item);
      }
    } catch (error) {
      logger.warn(
        `report recovery failed for ${charter.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: keep result evidence and retry next sweep | evidence: ${dotStatePath(charter, DOT_WORK_RESULTS_FILE)}`
      );
    }
  }
}

function isTerminalWorkResult(row: DotWorkResultRow): boolean {
  return (
    row.status === 'done' ||
    row.status === 'blocked' ||
    (row.status === 'failed' && row.mode === 'escalated')
  );
}

function scopedWorkResults(c: DotCharter, deps: DotExecutorDeps): DotWorkResultRow[] {
  const cached = deps.resultsCache?.get(resultsCacheKey(c));
  if (cached) return cached;
  const rows = withExecutionContext(
    c.authority.authority_role,
    () => readDotWorkResults(c, deps),
    undefined,
    c.scope.tenant_slug,
    c.scope.organization_id
  );
  deps.resultsCache?.set(resultsCacheKey(c), rows);
  return rows;
}

/** Terminal evidence is authoritative even if releasing the shared WorkItem failed. */
function terminalWorkResults(c: DotCharter, deps: DotExecutorDeps): Map<string, DotWorkResultRow> {
  const rows = scopedWorkResults(c, deps);
  return new Map(rows.filter(isTerminalWorkResult).map((row) => [row.work_item_id, row]));
}

/** Operator verification recorded by {@link releaseDotWorkItem}, if any. */
export interface DotOperatorVerification {
  operator_verified_at: string;
  operator_verified_by: string;
  operator_verified_reason: string;
}

function operatorVerification(item: WorkItem): DotOperatorVerification | undefined {
  const executor = item.metadata?.dot_executor as Record<string, unknown> | undefined;
  const at = executor?.operator_verified_at;
  if (typeof at !== 'string' || !at) return undefined;
  return {
    operator_verified_at: at,
    operator_verified_by: String(executor?.operator_verified_by ?? 'operator'),
    operator_verified_reason: String(executor?.operator_verified_reason ?? ''),
  };
}

/** Evidence recorded before an operator release no longer blocks the item. */
function supersededByRelease(row: DotWorkResultRow, item: WorkItem): boolean {
  const at = operatorVerification(item)?.operator_verified_at;
  return Boolean(at && row.completed_at <= at);
}

/** The item's terminal result unless an operator release superseded it. */
function activeTerminalResult(
  terminal: Map<string, DotWorkResultRow>,
  item: WorkItem
): DotWorkResultRow | undefined {
  const row = terminal.get(item.item_id);
  return row && !supersededByRelease(row, item) ? row : undefined;
}

/**
 * Neither a read-only label nor an abort request proves that a crashed port had
 * no effects. Only an operator release clears the attempts that preceded it.
 */
function hasUncertainAttempt(item: WorkItem): boolean {
  const releasedAt = operatorVerification(item)?.operator_verified_at ?? '';
  return Boolean(
    item.attempts?.some(
      (attempt) =>
        attempt.failure_reason === 'lease_expired' &&
        (attempt.ended_at ?? attempt.started_at) > releasedAt
    )
  );
}

/** Attempts since the last operator release (bounds pre-effect retries). */
function attemptsSinceRelease(item: WorkItem): number {
  const releasedAt = operatorVerification(item)?.operator_verified_at ?? '';
  return (item.attempts ?? []).filter(
    (attempt) => !releasedAt || (attempt.started_at ?? '') > releasedAt
  ).length;
}

/** IDs are immutable execution identities; a reused item needs operator reconciliation. */
function resultMatchesAttempt(row: DotWorkResultRow, item: WorkItem): boolean {
  if (row.action_ref !== (meta(item, 'action_ref') ?? item.item_id)) return false;
  // Reopening an already-released item is not orphan recovery. Even if its
  // identifiers were reused unchanged, do not report the reopened work done.
  if (row.status === 'done' && item.status !== 'in_progress' && !hasUncertainAttempt(item)) {
    return false;
  }
  // Work coordination's current_attempt_id is the attempt run_id, which is
  // also what the existing result contract stores in attempt_id.
  return row.attempt_id === (item.current_attempt_id ?? item.attempts?.at(-1)?.run_id);
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

export interface ReleaseDotWorkItemInput {
  workItemId: string;
  /** Why the operator is satisfied that no unverified effect remains. Required. */
  reason: string;
  /** Operator identity recorded as `operator_verified_by`; defaults to `operator`. */
  by?: string;
}

export interface ReleaseDotWorkItemDeps extends Pick<
  DotExecutorDeps,
  'rootDir' | 'now' | 'audit' | 'update' | 'resultsCache'
> {
  getItem?: (itemId: string) => WorkItem | null;
}

/**
 * Governed operator release of a quarantined or escalated dot WorkItem
 * (`pnpm kyberion dot release <dot_id> <work_item_id> --reason "<text>"`).
 * Records `metadata.dot_executor.operator_verified_at/by/reason`, returns the
 * item to `ready` and audits the release. Evidence (results, expired attempts)
 * recorded before the release stops blocking, so the executor re-attempts the
 * item under a NEW attempt id; anything after it still quarantines.
 */
export function releaseDotWorkItem(
  c: DotCharter,
  input: ReleaseDotWorkItemInput,
  deps: ReleaseDotWorkItemDeps = {}
): WorkItem {
  const reason = input.reason?.trim();
  if (!reason) throw new Error('[DOT_RELEASE_REASON] --reason "<what you verified>" is required');
  const by = input.by?.trim() || 'operator';
  const item = (deps.getItem ?? ((id: string) => getWorkItem(id)))(input.workItemId);
  if (!item) throw new Error(`[DOT_RELEASE_NOT_FOUND] no WorkItem '${input.workItemId}'`);
  if (!addressedTo(c, item)) {
    throw new Error(
      `[DOT_RELEASE_SCOPE] WorkItem '${item.item_id}' is not addressed to dot '${c.dot_id}'`
    );
  }
  if (dotItemTenantMismatch(c, item)) {
    throw new Error(
      `[DOT_RELEASE_SCOPE] WorkItem '${item.item_id}' belongs to another tenant scope than dot '${c.dot_id}'`
    );
  }
  if (item.lease_id || item.status === 'in_progress') {
    throw new Error(
      `[DOT_RELEASE_LEASED] WorkItem '${item.item_id}' is still leased — wait for the reaper to quarantine it`
    );
  }
  if (item.status === 'done') {
    throw new Error(
      `[DOT_RELEASE_DONE] WorkItem '${item.item_id}' is already done — nothing to release`
    );
  }
  const terminal = activeTerminalResult(terminalWorkResults(c, deps), item);
  const escalated = Boolean(
    (item.metadata?.dot_executor as Record<string, unknown> | undefined)?.escalated
  );
  if (!terminal && !hasUncertainAttempt(item) && !escalated) {
    throw new Error(
      `[DOT_RELEASE_NOTHING] WorkItem '${item.item_id}' carries no quarantine or escalation to release`
    );
  }
  const verification: DotOperatorVerification = {
    operator_verified_at: nowOf(deps).toISOString(),
    operator_verified_by: by,
    operator_verified_reason: bounded(reason, 300),
  };
  const priorExecutor = (item.metadata?.dot_executor as Record<string, unknown> | undefined) ?? {};
  const updated = withExecutionContext(GOVERNED_STORE_ROLE, () =>
    (deps.update ?? updateWorkItem)({
      itemId: item.item_id,
      expectedVersion: item.version,
      status: 'ready',
      metadata: {
        ...item.metadata,
        dot_executor: { ...priorExecutor, ...verification, released_from: item.status },
      },
    })
  );
  try {
    (deps.audit ?? ((entry) => auditChain.record(entry)))({
      agentId: by,
      actor: { kind: 'human', id: by },
      action: 'dot_action',
      operation: DOT_OPERATOR_RELEASE_OPERATION,
      result: 'allowed',
      metadata: {
        dot_id: c.dot_id,
        work_item_id: item.item_id,
        action_ref: meta(item, 'action_ref') ?? item.item_id,
        released_from: item.status,
        operator_verified_at: verification.operator_verified_at,
        ...(terminal ? { superseded_result_status: terminal.status } : {}),
        // Tenant prose stays out of the shared audit chain.
        ...(c.scope.tenant_slug ? {} : { reason: verification.operator_verified_reason }),
      },
      ...(c.scope.tenant_slug ? { tenantSlug: c.scope.tenant_slug } : {}),
    });
  } catch (error) {
    logger.warn(
      `release audit failed for ${item.item_id} — ${error instanceof Error ? error.message : String(error)} | next: the WorkItem metadata still records the operator verification | evidence: ${item.item_id}`
    );
  }
  return updated;
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
