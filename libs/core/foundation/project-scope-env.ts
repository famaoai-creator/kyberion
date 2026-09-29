import { getRegisteredEnvText } from './env.js';
import { isValidTenantSlug } from './scope.js';
import { rawExistsSync, rawLstatSync, rawReadTextFile } from '../fs-primitives.js';
import { assertSafeRepositoryPath, pathResolver } from '../path-resolver.js';

const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface ProjectScopeBinding {
  projectId?: string;
  tenantSlug?: string;
  missionId?: string;
  taskId?: string;
}

/**
 * Resolve the project binding without importing scope-context/secure-io.
 * Tier policy expansion runs inside secure-io authorization, so it must read
 * the governed scope.env through the foundation-only raw I/O boundary.
 * Environment values take precedence over the persisted scope, matching
 * resolveScopeResolution's persisted < environment < explicit input order.
 */
export function resolveProjectScope(): ProjectScopeBinding {
  let persisted: Record<string, string> = {};
  try {
    const configuredPath = getRegisteredEnvText('KYBERION_SCOPE_ENV_PATH')?.trim();
    const scopePath = assertSafeRepositoryPath(
      configuredPath || pathResolver.shared('runtime/scope.env'),
      { allowMissingLeaf: true }
    );
    if (rawExistsSync(scopePath) && rawLstatSync(scopePath).isFile()) {
      for (const line of rawReadTextFile(scopePath).split(/\r?\n/u)) {
        const match = line.match(
          /^(KYBERION_PROJECT_ID|KYBERION_TENANT|MISSION_ID|KYBERION_TASK_ID)=(.*)$/u
        );
        if (match) persisted[match[1]] = match[2].trim();
      }
    }
  } catch {
    persisted = {};
  }

  const environmentProjectId = getRegisteredEnvText('KYBERION_PROJECT_ID')?.trim();
  const environmentTenant = getRegisteredEnvText('KYBERION_TENANT')?.trim();
  const environmentMissionId = getRegisteredEnvText('MISSION_ID')?.trim();
  const environmentTaskId = getRegisteredEnvText('KYBERION_TASK_ID')?.trim();
  const projectId = environmentProjectId || persisted.KYBERION_PROJECT_ID;
  const tenantSlug = environmentTenant || persisted.KYBERION_TENANT;
  const missionId = environmentMissionId || persisted.MISSION_ID;
  const taskId = environmentTaskId || persisted.KYBERION_TASK_ID;
  return {
    ...(projectId && SAFE_PROJECT_ID.test(projectId) ? { projectId } : {}),
    ...(tenantSlug && isValidTenantSlug(tenantSlug) ? { tenantSlug } : {}),
    ...(missionId && SAFE_PROJECT_ID.test(missionId) ? { missionId } : {}),
    ...(taskId && SAFE_PROJECT_ID.test(taskId) ? { taskId } : {}),
  };
}

export function resolveProjectScopeId(): string | undefined {
  return resolveProjectScope().projectId;
}
