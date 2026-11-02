/** Narrow personal approval IO, not a grant of human decision authority. */
import { createHash } from 'node:crypto';
import { currentScopeEnvelope, runtimeScopeIdentity } from '../scope-envelope.js';

import { withPersonalApprovalCapability } from '../foundation/personal-approval-io-capability.js';
export {
  PERSONAL_APPROVAL_STORE_ROLE,
  personalApprovalIoAllowed,
} from '../foundation/personal-approval-io-capability.js';
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
    run
  );
}
