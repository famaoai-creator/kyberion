import * as path from 'node:path';
import type { ResourceAccessScope } from './resource-access-scope.js';
import { getProcessEnv } from './process-env.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from './runtime-state-roots.js';
import { isValidTenantSlug } from './scope.js';

/**
 * Narrow store role for one tenant's customer decision invite records
 * (`active/shared/runtime/customer-decision-invites/confidential/<tenant>/`,
 * libs/core/customer-decision/invite.ts). It grants no knowledge access.
 */
export const CUSTOMER_DECISION_INVITE_STORE_ROLE = 'customer_decision_invite_store';

const ROOT = PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites;
const FILE = /^inv-[a-f0-9]{16}\.json$/u;
const SANDBOX =
  /^active\/shared\/runtime\/vitest-live\/pool-[\w-]+\/shared\/runtime\/customer-decision-invites$/u;

/**
 * The deny-only ceiling for one invite operation. `target` is repo-relative:
 *   - the tenant directory: a listing (read of the directory only, never writes);
 *   - `<tenant dir>/inv-<16 hex>.json`: that one record, plus (when writing) the
 *     directories leading to it.
 * Product schema reads are allowed (records validate against a product schema).
 * Contains no path outside the tenant's own confidential invite partition.
 */
export function customerDecisionInviteCapability(
  tenantSlug: string,
  target: string,
  write: boolean
): ResourceAccessScope {
  if (!isValidTenantSlug(tenantSlug))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision invite tenant');
  if (path.posix.normalize(target) !== target)
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision invite path');
  const isFile = FILE.test(path.posix.basename(target));
  const directory = isFile ? path.posix.dirname(target) : target;
  const root = path.posix.dirname(path.posix.dirname(directory));
  if (
    directory !== root + '/confidential/' + tenantSlug ||
    !(root === ROOT || (getProcessEnv('VITEST') && SANDBOX.test(root))) ||
    (!isFile && write)
  )
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision invite path');
  return {
    tenantSlug,
    readExact: [target],
    writeExact: write ? [target] : [],
    mkdirExact: write ? [root, root + '/confidential', directory] : [],
    allowProductKnowledgeRead: true,
  };
}

export function isCustomerDecisionInviteCapability(
  scope: ResourceAccessScope | undefined
): boolean {
  if (
    !scope ||
    scope.organizationId ||
    scope.projectId ||
    scope.allowProductKnowledgeRead !== true ||
    (scope.metadataExact?.length ?? 0) !== 0 ||
    scope.readExact.length !== 1
  )
    return false;
  try {
    const expected = customerDecisionInviteCapability(
      scope.tenantSlug,
      scope.readExact[0]!,
      scope.writeExact.length > 0
    );
    return (
      JSON.stringify(scope.readExact) === JSON.stringify(expected.readExact) &&
      JSON.stringify(scope.writeExact) === JSON.stringify(expected.writeExact) &&
      JSON.stringify(scope.mkdirExact) === JSON.stringify(expected.mkdirExact)
    );
  } catch {
    return false;
  }
}
