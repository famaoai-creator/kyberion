import { buildExecutionEnv } from '../authority.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { isolatedScopeEnvPath } from '../scope-context.js';
import { pathResolver } from '../path-resolver.js';
import { safeExec, type SafeExecOptions } from '../secure-io.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import type { StorageDataTier } from '../storage-layout.js';

interface MissionStartScope {
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
}

/** Run one governed Mission controller command with the caller's scoped child environment. */
export function execMissionControllerChild(
  args: string[],
  options: SafeExecOptions,
  nodeCommand = 'node'
): string {
  return safeExec(nodeCommand, ['dist/scripts/mission_controller.js', ...args], options);
}

export function missionControllerHandoffEnv(
  tier?: StorageDataTier,
  scope?: MissionStartScope
): NodeJS.ProcessEnv {
  const env = buildExecutionEnv(process.env, 'mission_controller');
  if (!scope) return env;
  const execution = currentExecutionScope();
  const inherited = currentScopeEnvelope()?.identity;
  const boundTenant = execution?.tenantCleared
    ? undefined
    : execution?.tenantBound
      ? execution.tenantSlug
      : inherited?.tenant_slug;
  const boundOrg = execution?.organizationId ?? inherited?.organization_id;
  const explicitProject = execution?.executionIdentity?.projectId;
  const boundProject = explicitProject === undefined ? inherited?.project_id : explicitProject;
  if (
    ((execution?.tenantBound || execution?.tenantCleared || boundTenant !== undefined) &&
      boundTenant !== scope.tenant_slug) ||
    (boundOrg !== undefined && boundOrg !== scope.organization_id) ||
    (boundProject != null && boundProject !== scope.project_id)
  ) {
    throw new Error('Mission handoff scope conflicts with the current execution binding');
  }
  // Empty values override safeExec's inherited env. The verified handoff
  // replaces operator selections and parent task context.
  return Object.assign(env, {
    KYBERION_SCOPE_ENV_PATH: isolatedScopeEnvPath(),
    KYBERION_TIER: tier ?? '',
    KYBERION_TENANT: scope.tenant_slug ?? '',
    KYBERION_ORGANIZATION_ID: scope.organization_id ?? '',
    KYBERION_PROJECT_ID: scope.project_id ?? '',
    KYBERION_STANCE: '',
    KYBERION_CUSTOMER: '',
    MISSION_ID: '',
    KYBERION_TASK_ID: '',
    TASK_ID: '',
  });
}

/** Translate a scoped issuance or replay into the mission controller's CLI contract. */
export function missionControllerStartInput(input: {
  missionId: string;
  tier: StorageDataTier;
  missionType: string;
  orgRole: string;
  scope?: MissionStartScope;
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const { missionId, tier, missionType, orgRole, scope } = input;
  pathResolver.assertMissionIdArgument(missionId);
  if (
    [missionType, orgRole, scope?.tenant_slug, scope?.organization_id, scope?.project_id].some(
      (value) => value?.trim().startsWith('--')
    )
  ) {
    throw new Error('Mission type, Org Role and scope values must be identifiers');
  }
  const env = missionControllerHandoffEnv(tier, scope);
  const args = [
    'start',
    missionId,
    '--tier',
    tier,
    '--org-role',
    orgRole,
    '--mission-type',
    missionType,
  ];
  if (scope?.tenant_slug) args.push('--tenant-slug', scope.tenant_slug);
  if (scope?.organization_id) args.push('--organization-id', scope.organization_id);
  if (scope?.project_id) args.push('--project-id', scope.project_id);
  return { args, env };
}
