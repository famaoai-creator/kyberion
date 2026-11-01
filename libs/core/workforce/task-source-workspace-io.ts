/** Exact IO window for an already validated, live, same-tier task workspace.
 * No capability can be supplied by model arguments or stored in a grant file. */
import * as path from 'node:path';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import { storagePartitionSegments } from '../storage-layout.js';
import type { TaskToolBinding } from './task-tool-runtime.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import { resolveRole, resolveExecutionPersona } from '../authority.js';
import { withTaskSourceWorkspaceCapability } from '../foundation/task-source-workspace-capability.js';
export {
  TASK_SOURCE_WORKSPACE_ROLE,
  taskSourceWorkspaceIoActive,
  taskSourceWorkspaceIoAllowed,
} from '../foundation/task-source-workspace-capability.js';

export function withTaskSourceWorkspaceIo<T>(
  binding: TaskToolBinding,
  root: string,
  file: string,
  writing: boolean,
  assertCurrent: () => void,
  run: () => T
): T {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const prefix =
    [
      runtimeStatePath('task.workspacesRoot').physicalPath,
      ...storagePartitionSegments({
        kind: 'tier',
        tier: binding.scope.tier,
        tenant: binding.scope.tenant_slug,
      }),
    ].join('/') + '/';
  if (binding.scope.tier === 'public' || !relative.startsWith(prefix) || relative.includes('/../'))
    throw new Error(
      '[TASK_SOURCE_SCOPE_DENIED] Private workspace IO needs its exact physical tier'
    );
  assertCurrent();
  const caller = currentExecutionScope() ?? {
    tenantBound: Boolean(binding.scope.tenant_slug),
    tenantSlug: binding.scope.tenant_slug,
    assumedRole: resolveRole() || 'worker',
    assumedPersona: resolveExecutionPersona(),
  };
  const validate = () => runInExecutionScope(caller, assertCurrent);
  return withTaskSourceWorkspaceCapability(relative, writing, validate, run);
}
