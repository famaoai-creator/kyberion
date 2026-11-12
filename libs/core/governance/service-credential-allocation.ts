/** Fail-closed service allocation port; installed only by the grant-aware runtime bootstrap. */
import type { GrantRecord } from './grant-store.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
export interface ServiceAllocationUseScope {
  tenant_slug: string;
  project_id?: string;
  mission_id?: string;
  task_id?: string;
}
export type ServiceCredentialAllocationVerifier = (
  selected: ServiceBindingRecord,
  scope: ServiceAllocationUseScope,
  options?: { grantId?: string; action?: string }
) => GrantRecord;
let verifier: ServiceCredentialAllocationVerifier | undefined;
/** Trusted composition only, never selected from model/broker data. Returns scoped cleanup for tests. */
export function registerServiceCredentialAllocationVerifier(
  next: ServiceCredentialAllocationVerifier
): () => void {
  const previous = verifier;
  verifier = next;
  return () => {
    if (verifier === next) verifier = previous;
  };
}
export function assertServiceCredentialAllocation(
  selected: ServiceBindingRecord,
  scope: ServiceAllocationUseScope,
  options: { grantId?: string; action?: string } = {}
): GrantRecord {
  if (!verifier)
    throw new Error(
      '[SERVICE_CREDENTIAL_ALLOCATION_DENIED] Grant-aware runtime bootstrap is required'
    );
  return verifier(selected, scope, options);
}
