/**
 * Bounded verdict repair — append fix + recheck child WorkItems (replan ≤ 2).
 *
 * Absorbed from PiBot's appendVerdictRepairs. Does not rewrite static process
 * templates. A third append is refused with stop_reason `replan_limit`.
 *
 * @see knowledge/product/architecture/pibot-absorption-model.md
 */

import { createWorkItem, getWorkItem, updateWorkItem, type WorkItem } from '../workforce/work-coordination.js';
import type { WorkItemContext } from '../workforce/work-coordination-types.js';

export const MAX_VERDICT_REPAIRS = 2;

export type VerdictRepairStopReason =
  | 'replan_limit'
  | 'paused'
  | 'round_limit'
  | 'hard_limit'
  | 'recheck_skipped'
  | 'not_ready'
  | 'item_not_found';

export interface VerdictRepairState {
  mission_id: string;
  verdict_repair_count: number;
  paused?: boolean;
  hard_limit?: boolean;
  round_limit?: boolean;
}

export interface AppendVerdictRepairInput {
  missionId: string;
  failedChildItemId: string;
  actorId: string;
  state: VerdictRepairState;
  /** Parent Issue WorkItem id (mission ownership item). */
  parentItemId?: string;
  context?: WorkItemContext;
  rootDir?: string;
}

export type AppendVerdictRepairResult =
  | {
      ok: true;
      fix_item_id: string;
      recheck_item_id: string;
      repair_index: number;
      state: VerdictRepairState;
    }
  | { ok: false; stop_reason: VerdictRepairStopReason };

function readRepairCount(item: WorkItem | null): number {
  const raw = item?.metadata?.verdict_repair_count;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
}

/**
 * Append a fix WorkItem and a dependent recheck WorkItem under the mission.
 * Refuses when count would exceed {@link MAX_VERDICT_REPAIRS}, when paused /
 * limits collide, when the failed item was verification-skipped, or when the
 * failed item is missing / not blocked|review.
 */
export function appendVerdictRepair(input: AppendVerdictRepairInput): AppendVerdictRepairResult {
  const { state } = input;
  if (state.paused) return { ok: false, stop_reason: 'paused' };
  if (state.hard_limit) return { ok: false, stop_reason: 'hard_limit' };
  if (state.round_limit) return { ok: false, stop_reason: 'round_limit' };
  if (
    typeof state.verdict_repair_count === 'number' &&
    state.verdict_repair_count >= MAX_VERDICT_REPAIRS
  ) {
    return { ok: false, stop_reason: 'replan_limit' };
  }

  const failed = getWorkItem(
    input.failedChildItemId,
    input.rootDir ? { rootDir: input.rootDir } : {}
  );
  if (!failed) return { ok: false, stop_reason: 'item_not_found' };
  if (failed.metadata?.verification_skipped === true) {
    return { ok: false, stop_reason: 'recheck_skipped' };
  }
  if (failed.status !== 'blocked' && failed.status !== 'review') {
    return { ok: false, stop_reason: 'not_ready' };
  }

  // Prefer the higher of in-memory state and durable WorkItem metadata so a
  // stale caller state cannot undercount past repairs.
  const prior = Math.max(
    typeof state.verdict_repair_count === 'number' && Number.isFinite(state.verdict_repair_count)
      ? Math.max(0, Math.floor(state.verdict_repair_count))
      : 0,
    readRepairCount(failed)
  );
  if (prior >= MAX_VERDICT_REPAIRS) {
    return { ok: false, stop_reason: 'replan_limit' };
  }

  const repairIndex = prior + 1;
  const prefix = `verdict-repair-${repairIndex}`;
  const parentItemId = input.parentItemId ?? failed.parent_item_id;
  const context = input.context ?? failed.context;

  const fix = createWorkItem({
    title: `${prefix} fix: ${failed.title}`,
    description: `Bounded verdict repair fix for ${failed.item_id}`,
    status: 'ready',
    ...(parentItemId ? { parentItemId } : {}),
    ...(context ? { context } : {}),
    dependencies: [],
    metadata: {
      verdict_repair: true,
      verdict_repair_kind: 'fix',
      verdict_repair_index: repairIndex,
      verdict_repair_of: failed.item_id,
      verdict_repair_by: input.actorId,
    },
    ...(input.rootDir ? { rootDir: input.rootDir } : {}),
  });

  const recheck = createWorkItem({
    title: `${prefix} check: ${failed.title}`,
    description: `Bounded verdict repair recheck for ${failed.item_id}`,
    status: 'ready',
    ...(parentItemId ? { parentItemId } : {}),
    ...(context ? { context } : {}),
    dependencies: [fix.item_id],
    metadata: {
      verdict_repair: true,
      verdict_repair_kind: 'recheck',
      verdict_repair_index: repairIndex,
      verdict_repair_of: failed.item_id,
      verdict_repair_by: input.actorId,
      verification_step: true,
    },
    ...(input.rootDir ? { rootDir: input.rootDir } : {}),
  });

  updateWorkItem({
    itemId: failed.item_id,
    metadata: {
      ...(failed.metadata || {}),
      verdict_repair_count: repairIndex,
      verdict_repair_fix_id: fix.item_id,
      verdict_repair_recheck_id: recheck.item_id,
    },
    ...(input.rootDir ? { rootDir: input.rootDir } : {}),
  });

  return {
    ok: true,
    fix_item_id: fix.item_id,
    recheck_item_id: recheck.item_id,
    repair_index: repairIndex,
    state: {
      ...state,
      mission_id: input.missionId,
      verdict_repair_count: repairIndex,
    },
  };
}
