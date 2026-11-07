/**
 * Narrow personal approval IO, not a grant of human decision authority.
 *
 * G2 of the store-catalog guard design: the governed facade of the personal approval owner window.
 * The window is itself the authority for the I/O it covers (no store role). Who may open it is
 * unchanged: the rule that bounded assuming the former shared core role (RA-02,
 * role-assumption-policy `shared_core_roles`) applies to the issuance right
 * `personal_approval_store`. While it is open the caller keeps its own role and persona and runs
 * unbound (no tenant, no organization), as the role assumption bound it.
 */
import { createHash } from 'node:crypto';
import { currentScopeEnvelope, runtimeScopeIdentity } from '../scope-envelope.js';
import { assertStoreGrantIssuanceAllowed } from '../authority.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import {
  PERSONAL_APPROVAL_GRANT_ISSUANCE_RIGHT,
  withPersonalApprovalCapability,
} from '../foundation/personal-approval-io-capability.js';
import { TENANT_APPROVAL_ROOT_PATH } from '../foundation/runtime-state-roots.js';
import { VITEST_APPROVAL_STORE_ROOT } from './approval-store-paths.js';

/**
 * Where the former `personal_approval_store` role's policy grant let it write: the personal owner
 * partitions and the Vitest approval store. The window's writes are narrowed to these.
 */
const PERSONAL_APPROVAL_WRITE_ROOTS = Object.freeze([
  `${TENANT_APPROVAL_ROOT_PATH}/personal/shared`,
  VITEST_APPROVAL_STORE_ROOT,
]);

function asUnboundCaller<T>(action: () => T): T {
  assertStoreGrantIssuanceAllowed(PERSONAL_APPROVAL_GRANT_ISSUANCE_RIGHT);
  const {
    tenantCleared: _cleared,
    organizationId: _organization,
    tenantSlug: _tenant,
    ...current
  } = currentExecutionScope() ?? { tenantBound: false };
  return runInExecutionScope({ ...current, tenantBound: false }, action);
}
export function personalApprovalOwnerHash(nhi?: string): string {
  return nhi ? createHash('sha256').update(nhi).digest('hex') : 'unbound';
}
export function currentPersonalApprovalOwnerHash(): string | undefined {
  const envelope = currentScopeEnvelope();
  const scope = envelope?.identity ?? runtimeScopeIdentity();
  if (
    scope.tier !== 'personal' ||
    scope.tenant_slug ||
    (envelope && !envelope.policy.read_tiers.includes('personal'))
  )
    return undefined;
  return personalApprovalOwnerHash(scope.nhi_id);
}
export function withPersonalApprovalIo<T>(
  ownerHash: string,
  file: string,
  writing: boolean,
  run: () => T
): T {
  if (
    currentPersonalApprovalOwnerHash() !== ownerHash ||
    (writing &&
      currentScopeEnvelope() &&
      currentScopeEnvelope()!.policy.write_tier !== 'personal') ||
    (!file.includes(`/personal/shared/owners/${ownerHash}/`) &&
      !file.endsWith(`/personal/shared/owners/${ownerHash}`)) ||
    file.startsWith('/') ||
    file.includes('\\') ||
    file.split('/').includes('..')
  )
    throw new Error(
      '[PERSONAL_APPROVAL_SCOPE_REQUIRED] Actual personal owner and exact path required'
    );
  return withPersonalApprovalCapability(
    ownerHash,
    file,
    writing,
    () =>
      currentPersonalApprovalOwnerHash() === ownerHash &&
      (!writing ||
        !currentScopeEnvelope() ||
        currentScopeEnvelope()!.policy.write_tier === 'personal'),
    () => asUnboundCaller(run),
    PERSONAL_APPROVAL_WRITE_ROOTS
  );
}
