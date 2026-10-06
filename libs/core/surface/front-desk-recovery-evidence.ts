import { withLockSync } from '../foundation/lock-utils.js';
import { stateFile, workResultLock } from '../dot/dot-executor-reports.js';
/** Shared strict retained-output proof. Read-only and fail-closed, including missing ledgers. */
import { readJsonLines } from '../foundation/json.js';
import { assertSafeRepositoryPath, safeLstat } from '../secure-io.js';
import { physicalScopedPath } from '../physical-namespace.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotActionRecord } from '../dot/dot-dispatch.js';
import {
  DOT_WORK_RESULTS_FILE,
  dotStatePath,
  type DotWorkResultRow,
} from '../dot/dot-state-paths.js';
import type {
  FrontDeskExecutionBinding,
  FrontDeskExecutionMapping,
} from './front-desk-execution-contract.js';
import { frontDeskExecutionArtifactPath } from './front-desk-execution-artifact.js';
function reject(): never {
  throw new Error('incomplete_recovery_output_evidence');
}
/** Do not conflate inaccessible or dangling paths with absent effect files. */
function requireAbsent(file: string): void {
  const guarded = assertSafeRepositoryPath(file, { allowMissingLeaf: true });
  try {
    safeLstat(guarded);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  reject();
}
export function assertFrontDeskRecoveryOutputsAbsent(
  charter: DotCharter,
  binding: FrontDeskExecutionBinding,
  action: DotActionRecord,
  mapping: FrontDeskExecutionMapping
): void {
  const file = assertSafeRepositoryPath(dotStatePath(charter, DOT_WORK_RESULTS_FILE));
  const stat = safeLstat(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) reject();
  requireAbsent(frontDeskExecutionArtifactPath(binding, mapping));
  requireAbsent(
    physicalScopedPath(
      'active/shared/runtime/front-desk-execution',
      charter.scope,
      binding.work_item_id + '.json'
    )
  );
  for (const row of readJsonLines<DotWorkResultRow>(file)) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      ![row.dot_id, row.work_item_id, row.action_ref, row.started_at, row.completed_at].every(
        (value) => typeof value === 'string' && value.trim()
      ) ||
      !['goal_turn', 'delegated', 'pipeline', 'escalated'].includes(row.mode) ||
      !['done', 'blocked', 'failed', 'skipped'].includes(row.status) ||
      !Number.isFinite(Date.parse(row.started_at)) ||
      !Number.isFinite(Date.parse(row.completed_at))
    )
      reject();
    const links = new Set([
      binding.work_item_id,
      binding.request_id,
      action.action_ref,
      action.request_id,
    ]);
    const linked = (value: unknown, depth = 0): boolean => {
      if (depth > 32) reject();
      if (typeof value === 'string') return links.has(value);
      if (value && typeof value === 'object')
        return Object.values(value).some((child) => linked(child, depth + 1));
      return false;
    };
    if (linked(row)) reject();
  }
}

/** POST-only fence shared with all canonical result writers; reads never acquire it. */
export function withFrontDeskRecoveryResultLock<T>(charter: DotCharter, fn: () => T): T {
  return withLockSync(
    workResultLock(stateFile({}, dotStatePath(charter, DOT_WORK_RESULTS_FILE))),
    fn
  );
}
