/** Read-only execution evidence. Never claims, releases, reaps, repairs or wakes work. */
import type { DotCharter } from './dot-charter.js';
import type { DotExtCtx } from './dot-extensions.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import { readWorkItemInventory } from '../workforce/work-coordination.js';
import {
  declaredWorkTarget,
  workEffectOwnership,
  workTargetsOverlap,
} from '../workforce/work-effect-ownership.js';
import { addressedTo } from './dot-executor-reports.js';
import { inspectExecutorSchedulingCursor } from './dot-executor-scheduling.js';

export interface DotExecutionObservation {
  work_item_id: string;
  item_status: string;
  current_attempt_id?: string;
  latest_recorded_attempt_id?: string;
  held_attempt_id?: string;
  blocking_work_item_id?: string;
  state: 'blocked' | 'unknown' | 'running' | 'queued' | 'recorded';
  reason_code: string;
  reason: string;
  observed_since?: string;
  age_ms: number | null;
  next: string;
}

const RECONCILE =
  'An operator must verify execution stopped and reconcile partial or late effects. Do not retry or clear ownership automatically.';
const LIMIT = 20;
function sameScope(c: DotCharter, item: WorkItem): boolean {
  return (
    item.context?.tenant_slug === c.scope.tenant_slug &&
    item.context?.organization_id === c.scope.organization_id
  );
}
function age(at: unknown, now: number): number | null {
  if (typeof at !== 'string') return null;
  const timestamp = Date.parse(at);
  return Number.isFinite(timestamp) && Number.isFinite(now) && timestamp <= now
    ? now - timestamp
    : null;
}
function inspectItem(
  c: DotCharter,
  item: WorkItem,
  scoped: WorkItem[],
  now: number
): DotExecutionObservation {
  const result: DotExecutionObservation = {
    work_item_id: item.item_id,
    item_status: item.status,
    state: 'recorded',
    reason_code: 'recorded_state',
    reason: 'Persisted item state only; current executor liveness is not established.',
    observed_since: item.updated_at,
    age_ms: age(item.updated_at, now),
    next: 'Review current evidence; this status command never executes or resumes work.',
  };
  try {
    if (item.current_attempt_id !== undefined) {
      if (typeof item.current_attempt_id !== 'string' || !item.current_attempt_id)
        throw Error('attempt');
      result.current_attempt_id = item.current_attempt_id;
    }
    if (item.attempts !== undefined && !Array.isArray(item.attempts)) throw Error('attempts');
    if (item.lease_id !== undefined && (typeof item.lease_id !== 'string' || !item.lease_id))
      throw Error('lease');
    const attempts = item.attempts ?? [];
    const validStatuses = ['running', 'released', 'completed', 'blocked', 'failed', 'handed_off'];
    if (
      attempts.some(
        (a) =>
          !a ||
          typeof a !== 'object' ||
          typeof a.run_id !== 'string' ||
          !a.run_id ||
          typeof a.attempt_id !== 'string' ||
          !a.attempt_id ||
          !validStatuses.includes(a.status) ||
          age(a.started_at, now) === null ||
          (a.ended_at !== undefined &&
            (age(a.ended_at, now) === null || Date.parse(a.ended_at) < Date.parse(a.started_at)))
      )
    )
      throw Error('attempt');
    if (new Set(attempts.map((a) => a.run_id)).size !== attempts.length)
      throw Error('duplicate attempt');
    if (attempts.length) result.latest_recorded_attempt_id = attempts.at(-1)!.run_id;
    const matches = attempts.filter((a) => a.run_id === item.current_attempt_id);
    const inconsistent = item.current_attempt_id !== undefined && matches.length !== 1;
    const hold = workEffectOwnership(item);
    if (hold && hold.tenant_slug !== c.scope.tenant_slug) throw Error('scope');
    if (hold?.state === 'held') {
      result.held_attempt_id = hold.attempt_id;
      result.observed_since = hold.acquired_at;
      result.age_ms = age(hold.acquired_at, now);
      const heldMatches = attempts.filter((a) => a.run_id === hold.attempt_id);
      if (
        inconsistent ||
        heldMatches.length !== 1 ||
        result.age_ms === null ||
        (item.current_attempt_id !== undefined && item.current_attempt_id !== hold.attempt_id)
      ) {
        return {
          ...result,
          state: 'unknown',
          reason_code: 'held_evidence_inconsistent',
          reason:
            'Ownership is retained, but its attempt or time evidence is inconsistent; effects are not proven stopped.',
          next: RECONCILE,
        };
      }
      if (
        item.status === 'in_progress' &&
        item.current_attempt_id === hold.attempt_id &&
        matches[0]?.status === 'running'
      ) {
        return {
          ...result,
          state: 'running',
          reason_code: 'running_owner_snapshot',
          reason:
            'The item records a running owner; terminal results and lease evidence are not correlated, so this does not prove live execution.',
          next: 'Observe and reconcile this exact attempt before any retry; do not infer cancellation or release it based on age alone.',
        };
      }
      return {
        ...result,
        state: 'blocked',
        reason_code: 'retained_effect_hold',
        reason:
          'Effects remain owned after this attempt stopped being current; timeout or terminal item status does not prove cancellation.',
        next:
          RECONCILE +
          (item.status === 'archived' || item.status === 'blocked' || item.status === 'ready'
            ? ' After verification, use pnpm kyberion dot release <dot_id> <work_item_id>' +
              ' --reason "<verified reconciliation>" to request human approval; release guards still apply.'
            : ' Use the existing governed recovery flow; this record is not automatically eligible for release.'),
      };
    }
    if (
      inconsistent ||
      result.age_ms === null ||
      (item.status === 'in_progress' &&
        (!item.current_attempt_id || matches[0]?.status !== 'running'))
    )
      throw Error('attempt');
    if (item.status === 'ready') {
      const target = declaredWorkTarget(item);
      if (target) {
        for (const other of scoped) {
          if (other.item_id === item.item_id) continue;
          const owner = workEffectOwnership(other);
          if (
            owner?.state === 'held' &&
            owner.tenant_slug === c.scope.tenant_slug &&
            workTargetsOverlap(target, owner.target)
          ) {
            return {
              ...result,
              state: 'blocked',
              reason_code: 'target_owned',
              blocking_work_item_id: other.item_id,
              held_attempt_id: owner.attempt_id,
              observed_since: owner.acquired_at,
              age_ms: age(owner.acquired_at, now),
              reason:
                'Another item in this exact tenant and organization still owns the requested target.',
              next: RECONCILE,
            };
          }
        }
      }
      return {
        ...result,
        state: 'queued',
        reason_code: 'ready_snapshot',
        reason:
          'Ready snapshot; scheduling, approvals, budgets, dependencies and ownership outside this visible scope are not proven clear.',
        next: 'Ready is not permission to retry. Unsuperseded terminal results and expired attempts can still block work; inspect them through governed recovery.',
      };
    }
    if (item.status === 'in_progress')
      return {
        ...result,
        state: 'running',
        reason_code: 'running_snapshot',
        reason:
          'A current running attempt is recorded; liveness is not established by this snapshot.',
        next: 'Observe that exact attempt; do not restart it based on age alone.',
      };
    if (item.status === 'blocked')
      return {
        ...result,
        state: 'blocked',
        reason_code: 'item_blocked',
        reason:
          'The authoritative item is blocked; no safe retry is inferred from historical summaries.',
        next: RECONCILE,
      };
    return result;
  } catch {
    // Never echo malformed records or reader errors, which may contain another scope's prose.
    return {
      ...result,
      state: 'unknown',
      reason_code: 'item_evidence_unusable',
      reason: 'Current item, ownership or attempt evidence is malformed or inconsistent.',
      next: RECONCILE,
    };
  }
}

export function inspectDotExecution(c: DotCharter, ctx: DotExtCtx): Record<string, unknown> {
  const cursor = inspectExecutorSchedulingCursor(ctx.rootDir);
  const now = ctx.now().getTime();
  const base = {
    observed_at: Number.isFinite(now) ? new Date(now).toISOString() : null,
    charter_status: c.status,
    scheduling: cursor,
    scope: 'Exact typed tenant and organization; no inferred mission links.',
    limitations:
      'Read-only persisted evidence, not a liveness or claimability guarantee. Terminal results and lease evidence are not correlated with item snapshots; historical results are separate.',
  };
  try {
    const inventory = readWorkItemInventory({ rootDir: ctx.rootDir });
    if (!inventory.present)
      return {
        ...base,
        inventory: 'unknown',
        reason: 'Work item store is missing; current execution cannot be established.',
        items: [],
      };
    const scoped = inventory.items.filter((item) => sameScope(c, item));
    const items = scoped.filter((item) => addressedTo(c, item));
    const observations = items.map((item) => inspectItem(c, item, scoped, now));
    const priority = { blocked: 0, unknown: 1, running: 2, queued: 3, recorded: 4 };
    observations.sort(
      (a, b) =>
        priority[a.state] - priority[b.state] || a.work_item_id.localeCompare(b.work_item_id)
    );
    return {
      ...base,
      inventory: items.length ? 'observed' : 'no_current_evidence',
      reason: items.length
        ? 'Latest item snapshots observed; no executor action was taken.'
        : 'No exact-scope addressed items were observed; this is not proof of healthy progression.',
      items_total: items.length,
      items_omitted: Math.max(0, items.length - LIMIT),
      items: observations.slice(0, LIMIT),
    };
  } catch {
    return {
      ...base,
      inventory: 'unknown',
      reason:
        'Work item inventory is malformed or unreadable; current execution cannot be established.',
      items: [],
    };
  }
}
