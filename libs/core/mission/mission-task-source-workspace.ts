/** Owner-only preparation for ordinary private source tasks; no development/publication loop. */
import * as path from 'node:path';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import { resolveRole } from '../authority.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeContext } from '../scope-context.js';
import { resolveMissionDir } from '../governance/owner-scope.js';
import { loadState } from './mission-state.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import { writeMissionNextTasks } from './mission-lifecycle-completion.js';
import { listWorkItems } from '../workforce/work-coordination.js';
import { ensureMissionDevelopmentSourceWorkspace } from './mission-development-workspace.js';
import {
  TASK_SOURCE_ROOTS,
  validateTaskSourceWorkspace,
} from '../foundation/task-tool-grant-validation.js';

/**
 * Caller authority and current scope are resolved, never accepted as arguments.
 * Preparation precedes dispatch: changing an already issued tool grant is refused.
 */
export function prepareMissionTaskSourceWorkspace(
  missionId: string,
  taskId: string,
  baselineCommit: string
): { cwd: string; sourcePaths: string[]; created: boolean } {
  const id = missionId.toUpperCase();
  if (![id, taskId].every((value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)))
    throw new Error('[TASK_WORKSPACE_INVALID] Exact mission and task IDs required');
  const assertOwner = () => {
    if (resolveRole() !== 'mission_controller')
      throw new Error('[TASK_WORKSPACE_OWNER] mission_controller execution context required');
  };
  assertOwner();
  const state = loadState(id);
  if (!state || state.mission_id !== id || state.status !== 'active')
    throw new Error('[TASK_WORKSPACE_STATE] An active mission is required');
  if (state.tier === 'public')
    throw new Error(
      '[TASK_WORKSPACE_SCOPE] Ordinary private source preparation refuses public scope'
    );
  const dir = resolveMissionDir(id);
  const readTask = () => {
    const rows = loadMissionNextTaskObjectsAtPath(path.join(dir, 'NEXT_TASKS.json'), id);
    const matches = rows?.filter((row) => row.task_id === taskId) ?? [];
    if (matches.length !== 1)
      throw new Error('[TASK_WORKSPACE_TASK] Exact canonical task required');
    return matches[0];
  };
  const task = readTask();
  const original = JSON.stringify(task);
  const stateScope = JSON.stringify({
    tier: state.tier,
    tenant: state.tenant_slug ?? '',
    organization: state.organization_id ?? state.relationships?.organization?.organization_id ?? '',
    project: state.relationships?.project?.project_id ?? '',
  });
  const assertCurrent = (expected = original) => {
    assertOwner();
    const live = loadState(id);
    const scope = currentScopeEnvelope()?.identity ?? resolveScopeContext();
    if (!live || live.mission_id !== id || live.status !== 'active')
      throw new Error('[TASK_WORKSPACE_STATE] Mission is no longer active');
    const currentScope = JSON.stringify({
      tier: live.tier,
      tenant: live.tenant_slug ?? '',
      organization: live.organization_id ?? live.relationships?.organization?.organization_id ?? '',
      project: live.relationships?.project?.project_id ?? '',
    });
    if (
      currentScope !== stateScope ||
      scope.tier !== live.tier ||
      (scope.tenant_slug ?? '') !== (live.tenant_slug ?? '') ||
      (scope.organization_id ?? '') !==
        (live.organization_id ?? live.relationships?.organization?.organization_id ?? '') ||
      (scope.project_id ?? '') !== (live.relationships?.project?.project_id ?? '') ||
      (scope.mission_id !== undefined && scope.mission_id !== id) ||
      (scope.task_id !== undefined && scope.task_id !== taskId)
    )
      throw new Error('[TASK_WORKSPACE_SCOPE] Current execution scope differs from mission/task');
    const current = readTask();
    if (JSON.stringify(current) !== expected)
      throw new Error('[TASK_WORKSPACE_CHANGED] Canonical task contract changed');
    if (current.status !== 'planned' || current.ticket_dispatch)
      throw new Error('[TASK_WORKSPACE_DISPATCH] Only planned, undispatched tasks can be prepared');
    const dispatched = listWorkItems({
      ...(live.tenant_slug ? { tenantSlugs: [live.tenant_slug] } : {}),
      ...((live.organization_id ?? live.relationships?.organization?.organization_id)
        ? {
            organizationIds: [
              live.organization_id ?? live.relationships!.organization!.organization_id,
            ],
          }
        : {}),
    }).some((item) => item.context?.mission_id === id && item.context.task_id === taskId);
    if (dispatched)
      throw new Error('[TASK_WORKSPACE_DISPATCH] Task already has a dispatched WorkItem');
  };
  assertCurrent();
  const contract = validateTaskSourceWorkspace(
    task.source_workspace ?? {
      version: 1,
      baseline_commit: baselineCommit,
      source_paths: task.source_edit_paths,
    }
  );
  if (contract.baseline_commit !== baselineCommit)
    throw new Error(
      '[TASK_WORKSPACE_CHANGED] Reviewed baseline differs from the existing contract'
    );
  const sourceTarget =
    typeof task.target_path === 'string' &&
    TASK_SOURCE_ROOTS.some((root) => String(task.target_path).startsWith(root))
      ? task.target_path
      : undefined;
  if (task.source_workspace !== undefined && sourceTarget)
    throw new Error(
      '[TASK_WORKSPACE_TARGET] Prepared source target must remain in its private grant'
    );
  if (
    typeof task.target_path === 'string' &&
    task.target_path.startsWith(runtimeStatePath('task.workspacesRoot').physicalPath + '/') &&
    !(Array.isArray(task.source_edit_paths) && task.source_edit_paths.includes(task.target_path))
  )
    throw new Error('[TASK_WORKSPACE_TARGET] Private source target is outside the exact grant');
  if (sourceTarget && !contract.source_paths.includes(sourceTarget))
    throw new Error('[TASK_WORKSPACE_TARGET] Source target is outside the exact reviewed grant');
  const workspace = ensureMissionDevelopmentSourceWorkspace(
    state,
    taskId,
    contract.source_paths,
    assertCurrent,
    { localBaselineCommit: baselineCommit }
  );
  if (!workspace)
    throw new Error('[TASK_WORKSPACE_MISSING] Independent source workspace unavailable');
  assertCurrent();
  if (task.source_workspace !== undefined) {
    if (JSON.stringify(task.source_edit_paths) !== JSON.stringify(workspace.sourcePaths))
      throw new Error('[TASK_WORKSPACE_CHANGED] Prepared exact source paths differ from contract');
    return workspace;
  }
  const preparedTask = {
    ...task,
    source_edit_paths: workspace.sourcePaths,
    source_workspace: contract,
    ...(sourceTarget
      ? { target_path: workspace.sourcePaths[contract.source_paths.indexOf(sourceTarget)] }
      : {}),
  };
  const written = writeMissionNextTasks(dir, (rows) => {
    assertCurrent();
    const row = rows.find((entry) => entry.task_id === taskId);
    if (!row || JSON.stringify(row) !== original)
      throw new Error('[TASK_WORKSPACE_CHANGED] Board changed before source binding');
    return rows.map((entry) => (entry.task_id === taskId ? preparedTask : entry));
  });
  if (!written)
    throw new Error('[TASK_WORKSPACE_CHANGED] Source workspace binding was not persisted');
  assertCurrent(JSON.stringify(preparedTask));
  return workspace;
}
