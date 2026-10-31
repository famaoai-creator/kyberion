/** Digest labels are observations, never inferred execution success from dispatch. */
import * as path from 'node:path';
import { readJsonLines } from '../foundation/json.js';
import { projectDotResultRecords, dotResultScopeSchema } from './dot-result-records.js';
import { pathResolver } from '../path-resolver.js';
import { getWorkItem } from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import { listDotCharters, type DotCharter } from './dot-charter.js';
import type { DotActionRecord } from './dot-action-ledger.js';
import { dotStatePath, DOT_WORK_RESULTS_FILE, type DotWorkResultRow } from './dot-state-paths.js';
export interface DigestEvidenceDeps {
  rootDir?: string;
  listCharters?: () => DotCharter[];
  findWorkItemByActionRef?: (ref: string) => WorkItem | undefined;
  readWorkResults?: (charter: DotCharter) => DotWorkResultRow[];
}
export function dotDigestActionEvidence(
  charter: DotCharter,
  action: DotActionRecord,
  deps: DigestEvidenceDeps
): { status: string; at: string } {
  const fallback = { status: action.status === 'admitted' ? 'admitted' : 'queued', at: action.at };
  if (!action.work_item_id) return fallback;
  const executor = action.handoff_to
    ? (
        deps.listCharters?.() ??
        listDotCharters(deps.rootDir, { errors: [] }).map((row) => row.charter)
      ).find((row) => row.dot_id === action.handoff_to)
    : charter;
  if (
    !executor ||
    executor.scope.tenant_slug !== charter.scope.tenant_slug ||
    executor.scope.organization_id !== charter.scope.organization_id ||
    executor.scope.project_id !== charter.scope.project_id ||
    executor.scope.tier !== charter.scope.tier
  )
    return fallback;
  try {
    const item = deps.findWorkItemByActionRef
      ? deps.findWorkItemByActionRef(action.action_ref)
      : getWorkItem(action.work_item_id, { rootDir: deps.rootDir });
    if (
      !item ||
      item.item_id !== action.work_item_id ||
      item.metadata?.action_ref !== action.action_ref ||
      item.context?.tenant_slug !== charter.scope.tenant_slug ||
      item.context?.organization_id !== charter.scope.organization_id ||
      (item.context?.project_id ?? 'default') !== (charter.scope.project_id ?? 'default')
    )
      return fallback;
    const rawRows =
      deps.readWorkResults?.(executor) ??
      readJsonLines<DotWorkResultRow>(
        path.join(
          deps.rootDir ?? pathResolver.rootDir(),
          dotStatePath(executor, DOT_WORK_RESULTS_FILE)
        )
      );
    const rows = projectDotResultRecords(
      rawRows,
      executor.scope.tier === 'confidential'
        ? dotResultScopeSchema.parse(executor.scope)
        : undefined
    ) as DotWorkResultRow[];
    const result = rows
      .filter(
        (row) =>
          row.dot_id === executor.dot_id &&
          row.work_item_id === action.work_item_id &&
          row.action_ref === action.action_ref
      )
      .at(-1);
    const releasedAt = (
      item.metadata?.dot_executor as { operator_verified_at?: string } | undefined
    )?.operator_verified_at;
    const attempt = item.current_attempt_id ?? item.attempts?.at(-1)?.run_id;
    if (
      result &&
      typeof attempt === 'string' &&
      Boolean(attempt) &&
      result.attempt_id === attempt &&
      (!releasedAt || result.completed_at > releasedAt) &&
      ['done', 'blocked', 'failed'].includes(result.status) &&
      !(result.status === 'done' && !['done', 'archived', 'in_progress'].includes(item.status))
    )
      return { status: result.status, at: result.completed_at };
    return {
      status:
        item.status === 'in_progress'
          ? 'running'
          : item.status === 'blocked'
            ? 'blocked'
            : fallback.status,
      at: action.at,
    };
  } catch {
    return fallback;
  }
}
