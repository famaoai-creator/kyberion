import { currentResourceAccessScope } from './resource-access-scope.js';
import { currentExecutionScope } from './execution-scope.js';

/** Exact coverage checkpoint projection; observation/content and mutation have no capability. */
export function informationAssetCoverageReadAllowed(
  relativePath: string,
  role: string | undefined
): boolean {
  if (
    !['concierge_management_reader', 'chronos_operator', 'chronos_localadmin'].includes(role ?? '')
  )
    return false;
  const resource = currentResourceAccessScope();
  const execution = currentExecutionScope();
  if (
    !resource ||
    !execution?.tenantBound ||
    resource.writeExact.length ||
    resource.mkdirExact.length ||
    (resource.appendExact?.length ?? 0) ||
    !resource.readExact.includes(relativePath)
  )
    return false;
  const match = relativePath.match(
    /^active\/shared\/runtime\/dot\/confidential\/([a-z][a-z0-9-]{1,30})\/organizations\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/projects\/([A-Za-z0-9][A-Za-z0-9_-]*))?\/information-assets\/collections\/[A-Za-z0-9][A-Za-z0-9_-]*\.json$/u
  );
  return Boolean(
    match &&
    resource.tenantSlug === match[1] &&
    execution.tenantSlug === match[1] &&
    resource.organizationId === match[2] &&
    execution.organizationId === match[2] &&
    resource.projectId === match[3] &&
    (execution.executionIdentity?.projectId ?? undefined) === match[3]
  );
}
