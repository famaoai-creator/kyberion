/**
 * Dot executor work results and report-back (split from `dot-executor.ts`).
 *
 * Shared base of the executor modules: the {@link DotExecutorDeps} ports,
 * the tenant-scoped `work-results.jsonl` ledger (append, cache, terminal
 * evidence, operator-release supersession), KR / signal snapshots, the
 * report-back inbox reconciliation, the wake-prompt results section and the
 * executor audit entry. `dot-executor.ts` re-exports the public names; this
 * module never imports it (no runtime cycle).
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { auditChain } from '../governance/audit-chain.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import {
  listWorkItems,
  type claimWorkItem,
  type releaseWorkItem,
  type renewWorkItemLease,
  type updateWorkItem,
  type ReapWorkLeasesOptions,
  type ReapWorkLeasesResult,
} from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';
import type { DotExtCtx, DotPromptSection } from './dot-extensions.js';
import { readDotSignals } from './dot-feedback.js';
import { appendDotInboxEntry, type DotInboxEntryInput } from './dot-inbox.js';
import { DOT_EXECUTOR_REPORT_SOURCE } from './dot-runtime.js';
import {
  DOT_KR_LEDGER_FILE,
  DOT_WORK_RESULTS_FILE,
  dotStatePath,
  type DotWorkResultRow,
  type KrMeasurementRow,
} from './dot-state-paths.js';

const logger = createLogger('dot-executor');

/** Max characters of a result summary. */
export const DOT_WORK_RESULT_SUMMARY_MAX = 600;

/** Results shown in the wake prompt. */
export const DOT_WORK_RESULTS_PROMPT_LIMIT = 5;

/** libs/core governed stores (WorkItems) write under this shared role, as in dispatch. */
export const GOVERNED_STORE_ROLE = 'infrastructure_sentinel';

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

export function nowOf(deps: DotExecutorDeps): Date {
  return deps.now?.() ?? new Date();
}

export function stateFile(deps: DotExecutorDeps, rel: string): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), rel);
}

export function actorOf(c: DotCharter): string {
  return `dot:${c.dot_id}`;
}

export function bounded(text: string, max = DOT_WORK_RESULT_SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function meta(item: WorkItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function addressedTo(c: DotCharter, item: WorkItem): boolean {
  const handoffTo = meta(item, 'handoff_to');
  if (handoffTo) return handoffTo === c.dot_id;
  return meta(item, 'dot_id') === c.dot_id;
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

export function resultsCacheKey(c: DotCharter): string {
  return `${dotStatePath(c, DOT_WORK_RESULTS_FILE)}\u0000${c.dot_id}`;
}

export function ownRows(c: DotCharter, rows: DotWorkResultRow[]): DotWorkResultRow[] {
  return rows.filter((row) => row?.dot_id === c.dot_id && typeof row.work_item_id === 'string');
}

export function appendWorkResult(
  c: DotCharter,
  row: DotWorkResultRow,
  deps: DotExecutorDeps
): void {
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

export function workResultLock(file: string): string {
  return `dot-results-${createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 24)}`;
}

export function executorReportKey(row: DotWorkResultRow, reportTo: string): string {
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
export function markReportEnqueued(
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
export function enqueueExecutorReport(
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
export function reconcileExecutorReports(
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

export function isTerminalWorkResult(row: DotWorkResultRow): boolean {
  return (
    row.status === 'done' ||
    row.status === 'blocked' ||
    (row.status === 'failed' && row.mode === 'escalated')
  );
}

export function scopedWorkResults(c: DotCharter, deps: DotExecutorDeps): DotWorkResultRow[] {
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
export function terminalWorkResults(
  c: DotCharter,
  deps: DotExecutorDeps
): Map<string, DotWorkResultRow> {
  const rows = scopedWorkResults(c, deps);
  return new Map(rows.filter(isTerminalWorkResult).map((row) => [row.work_item_id, row]));
}

/** Operator verification recorded by {@link applyApprovedDotReleases}, if any. */
export interface DotOperatorVerification {
  operator_verified_at: string;
  operator_verified_by: string;
  operator_verified_reason: string;
  /** Approval request whose human decision released the item. */
  operator_verified_approval_id?: string;
}

export function operatorVerification(item: WorkItem): DotOperatorVerification | undefined {
  const executor = item.metadata?.dot_executor as Record<string, unknown> | undefined;
  const at = executor?.operator_verified_at;
  if (typeof at !== 'string' || !at) return undefined;
  return {
    operator_verified_at: at,
    operator_verified_by: String(executor?.operator_verified_by ?? 'operator'),
    operator_verified_reason: String(executor?.operator_verified_reason ?? ''),
    ...(typeof executor?.operator_verified_approval_id === 'string'
      ? { operator_verified_approval_id: executor.operator_verified_approval_id }
      : {}),
  };
}

/** Evidence recorded before an operator release no longer blocks the item. */
export function supersededByRelease(row: DotWorkResultRow, item: WorkItem): boolean {
  const at = operatorVerification(item)?.operator_verified_at;
  return Boolean(at && row.completed_at <= at);
}

/** The item's terminal result unless an operator release superseded it. */
export function activeTerminalResult(
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
export function hasUncertainAttempt(item: WorkItem): boolean {
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
export function attemptsSinceRelease(item: WorkItem): number {
  const releasedAt = operatorVerification(item)?.operator_verified_at ?? '';
  return (item.attempts ?? []).filter(
    (attempt) => !releasedAt || (attempt.started_at ?? '') > releasedAt
  ).length;
}

/** IDs are immutable execution identities; a reused item needs operator reconciliation. */
export function resultMatchesAttempt(row: DotWorkResultRow, item: WorkItem): boolean {
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

export function recordAudit(
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

/** True when the item's context tenant differs from the executing charter's tenant. */
export function dotItemTenantMismatch(c: DotCharter, item: WorkItem): boolean {
  const itemTenant = item.context?.tenant_slug || undefined;
  const charterTenant = c.scope.tenant_slug || undefined;
  return itemTenant !== charterTenant;
}
