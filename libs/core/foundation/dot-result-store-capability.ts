/** Internal exact DOT result storage ceiling. Only the governed result facade may issue it. */
import * as path from 'node:path';
import { isValidTenantSlug } from './scope.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from './runtime-state-roots.js';
import {
  createSynchronousResourceGrantIssuer,
  decideResourceAccess,
  type ResourceAccessScope,
  type ResourceAccessOperation,
} from './resource-access-scope.js';

export const DOT_RESULT_STORE_ROLE = 'dot_result_writer';
export interface DotResultStoreBinding {
  rootDir: string;
  scope: {
    tier: 'confidential';
    tenant_slug: string;
    organization_id?: string;
    project_id?: string;
  };
  dotId: string;
  file: string;
}
export type DotResultStoreOperation = 'append_result' | 'append_report_marker' | 'read_state';
const grants = createSynchronousResourceGrantIssuer<DotResultStoreBinding>('DOT_RESULT_CAPABILITY');
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
function normalized(input: DotResultStoreBinding): DotResultStoreBinding {
  const plain = (value: object): boolean =>
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!
    );
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'dotId,file,rootDir,scope' ||
    !plain(input) ||
    typeof input.rootDir !== 'string' ||
    !path.isAbsolute(input.rootDir) ||
    path.resolve(input.rootDir) !== input.rootDir ||
    typeof input.dotId !== 'string' ||
    !ID.test(input.dotId) ||
    !input.scope ||
    !plain(input.scope) ||
    input.scope.tier !== 'confidential' ||
    !isValidTenantSlug(input.scope.tenant_slug) ||
    Object.keys(input.scope).some(
      (key) => !['tier', 'tenant_slug', 'organization_id', 'project_id'].includes(key)
    ) ||
    (Object.hasOwn(input.scope, 'organization_id') &&
      (typeof input.scope.organization_id !== 'string' || !ID.test(input.scope.organization_id))) ||
    (Object.hasOwn(input.scope, 'project_id') &&
      (!input.scope.organization_id ||
        typeof input.scope.project_id !== 'string' ||
        !ID.test(input.scope.project_id)))
  )
    throw new Error('[DOT_RESULT_CAPABILITY_INVALID] Exact confidential DOT binding required');
  const file = [
    PARTITIONED_RUNTIME_STATE_ROOTS.dot,
    'confidential',
    input.scope.tenant_slug,
    ...(input.scope.organization_id ? ['organizations', input.scope.organization_id] : []),
    ...(input.scope.project_id ? ['projects', input.scope.project_id] : []),
    'work-results.jsonl',
  ].join('/');
  if (input.file !== file)
    throw new Error('[DOT_RESULT_CAPABILITY_INVALID] Result file differs from its scope');
  return Object.freeze({
    rootDir: input.rootDir,
    scope: Object.freeze({ ...input.scope }),
    dotId: input.dotId,
    file,
  });
}
/** Internal synchronous issuer, import-restricted to dot/dot-result-store.ts. No role is assumed. */
export function withDotResultStoreCapability<T>(
  input: DotResultStoreBinding,
  operation: DotResultStoreOperation,
  internalFn: () => T
): T {
  const binding = normalized(input);
  if (!['append_result', 'append_report_marker', 'read_state'].includes(operation))
    throw new Error('[DOT_RESULT_CAPABILITY_INVALID] Unknown operation');
  const write = operation !== 'read_state';
  const directories: string[] = [];
  if (write)
    for (
      let directory = path.posix.dirname(binding.file);
      directory !== '.';
      directory = path.posix.dirname(directory)
    )
      directories.push(directory);
  const scope: ResourceAccessScope = {
    tenantSlug: binding.scope.tenant_slug,
    ...(binding.scope.organization_id ? { organizationId: binding.scope.organization_id } : {}),
    ...(binding.scope.project_id ? { projectId: binding.scope.project_id } : {}),
    readExact: write ? [] : [binding.file],
    writeExact: [],
    appendExact: write ? [binding.file] : [],
    mkdirExact: directories,
    metadataExact: [binding.file],
  };
  return grants.run(binding, scope, internalFn);
}
/** Pure mandatory guard; structural lookalikes and expired asynchronous contexts fail closed. */
export function isDotResultStoreCapability(
  scope: ResourceAccessScope | undefined,
  request: { rootDir: string; target: string; operation: ResourceAccessOperation }
): boolean {
  const grant = grants.resolve(scope);
  if (!grant) return false;
  if (grant.binding.rootDir !== request.rootDir) return false;
  return decideResourceAccess(grant.scope, request.target, request.operation).allowed;
}
