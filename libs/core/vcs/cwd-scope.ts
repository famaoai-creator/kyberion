/** A subprocess cwd is a data source too: exec permission never lowers its tier. */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath } from '../secure-io.js';
import { detectTier, validateReadPermission } from '../tier-guard.js';
import { currentScopeEnvelope, runtimeScopeIdentity } from '../scope-envelope.js';
import { tenantRuntimePartitionOf, classifyStorageFloorPath } from '../storage-layout.js';
import { listWorkspaces, workspaceOwnerScope } from '../workforce/workspace-ledger.js';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';

export function assertVcsCwdScope(cwd?: string): void {
  const literal = path.resolve(cwd ?? pathResolver.rootDir());
  // Validate every ancestor before classifying. The filesystem root here is
  // a structural symlink boundary, not an authorization grant for its files.
  const absolute = assertSafeRepositoryPath(literal, { rootDir: path.parse(literal).root });
  const tier = detectTier(absolute);
  const envelope = currentScopeEnvelope();
  const source = envelope?.identity ?? runtimeScopeIdentity();
  const ranks = { public: 1, confidential: 2, personal: 3 } as const;
  if (!(source.tier in ranks) || (envelope && !envelope.policy.read_tiers.includes(tier)))
    throw new Error('[VCS_CWD_SCOPE_DENIED] Repository tier is outside the active read ceiling');
  if (tier === 'public') return;
  const relative = path.relative(pathResolver.rootDir(), absolute).split(path.sep).join('/');
  const runtime = tenantRuntimePartitionOf(relative);
  const floor = classifyStorageFloorPath(relative)?.partition;
  const tenant = runtime?.tenant ?? (floor?.kind === 'tier' ? floor.tenant : undefined);
  if (
    !(source.tier in ranks) ||
    ranks[source.tier] < ranks[tier] ||
    (envelope && !envelope.policy.read_tiers.includes(tier)) ||
    (tier === 'confidential' && !tenant) ||
    (tenant ? tenant !== source.tenant_slug : Boolean(source.tenant_slug))
  )
    throw new Error('[VCS_CWD_SCOPE_DENIED] Repository source differs from the active data scope');
  if (
    runtime?.key === 'task_workspaces' ||
    relative.startsWith(runtimeStatePath('task.workspacesRoot').physicalPath + '/')
  ) {
    const records = listWorkspaces().filter(
      (record) =>
        record.live &&
        (absolute === path.resolve(record.path) ||
          absolute.startsWith(path.resolve(record.path) + path.sep))
    );
    if (records.length !== 1)
      throw new Error(
        '[VCS_CWD_SCOPE_DENIED] Private repository needs one live canonical workspace'
      );
    const record = records[0];
    const owner = workspaceOwnerScope(record.owner);
    if (
      !owner ||
      owner.tier !== tier ||
      owner.tenant !== (source.tenant_slug ?? 'shared') ||
      (source.mission_id && source.mission_id !== record.owner.mission_id) ||
      (source.organization_id && source.organization_id !== owner.organization_id) ||
      (source.project_id && source.project_id !== owner.project_id) ||
      (source.task_id && source.task_id !== record.owner.task_id)
    )
      throw new Error(
        '[VCS_CWD_SCOPE_DENIED] Private repository owner differs from the active entity scope'
      );
  }
  if (!validateReadPermission(absolute).allowed)
    throw new Error('[VCS_CWD_SCOPE_DENIED] Repository read permission is not available');
}
