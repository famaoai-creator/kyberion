/** Exact IO window for an already validated, live, same-tier task workspace.
 * No capability can be supplied by model arguments or stored in a grant file.
 *
 * G2: the window is the authority for the target's I/O (no task_source_workspace role).
 * The only opener of the private window (foundation/task-source-workspace-capability.ts,
 * import boundary test). Inside it the I/O keeps the caller's role and persona and is bound
 * to the task's tenant and organization, exactly as the former role assumption bound it;
 * every I/O made inside is narrowed to the window, while liveness runs as the caller with
 * the window suspended. Any in-process caller may open one (the role was a shared core role). */
import * as path from 'node:path';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import { storagePartitionSegments } from '../storage-layout.js';
import type { TaskToolBinding } from './task-tool-runtime.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import { resolveRole, resolveExecutionBaseRole } from '../authority.js';
import {
  taskSourceWorkspaceIoActive as windowActive,
  withTaskSourceWorkspaceCapability,
} from '../foundation/task-source-workspace-capability.js';

/** Is a live window of this module instance current? Re-checks liveness. */
export function taskSourceWorkspaceIoActive(): boolean {
  return windowActive();
}

export function withTaskSourceWorkspaceIo<T>(
  binding: TaskToolBinding,
  root: string,
  file: string,
  writing: boolean,
  assertCurrent: () => void,
  run: () => T
): T {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const tier = binding.scope.tier;
  if (tier !== 'personal' && tier !== 'confidential')
    throw new Error(
      '[TASK_SOURCE_SCOPE_DENIED] Private workspace IO needs its exact physical tier'
    );
  const [, tenant] = storagePartitionSegments({
    kind: 'tier',
    tier,
    tenant: binding.scope.tenant_slug,
  });
  const prefix =
    [runtimeStatePath('task.workspacesRoot').physicalPath, tier, tenant].join('/') + '/';
  if (!relative.startsWith(prefix) || relative.includes('/../'))
    throw new Error(
      '[TASK_SOURCE_SCOPE_DENIED] Private workspace IO needs its exact physical tier'
    );
  assertCurrent();
  const caller = currentExecutionScope() ?? {
    tenantBound: Boolean(binding.scope.tenant_slug),
    tenantSlug: binding.scope.tenant_slug,
    assumedRole: resolveRole() || 'worker',
    assumedBaseRole: resolveExecutionBaseRole(),
  };
  const validate = () => runInExecutionScope(caller, assertCurrent);
  // The binding the former role assumption applied (withExecutionContext with the task's
  // tenant and organization), without changing the caller's role or persona.
  const {
    tenantCleared: _cleared,
    tenantSlug: _tenant,
    organizationId: _organization,
    ...rest
  } = caller as typeof caller & { tenantCleared?: true; organizationId?: string };
  const tenantSlug = binding.scope.tenant_slug;
  const organizationId = binding.scope.organization_id;
  const io = {
    ...rest,
    tenantBound: tenantSlug !== undefined,
    ...(tenantSlug ? { tenantSlug } : {}),
    ...(organizationId ? { organizationId } : {}),
  };
  return withTaskSourceWorkspaceCapability(
    { target: relative, writing, tier, tenant: tenant! },
    validate,
    () => runInExecutionScope(io, run)
  );
}
