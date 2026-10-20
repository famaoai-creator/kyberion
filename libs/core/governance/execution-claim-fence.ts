import { listApprovalRequests } from './approval-store-reader.js';
import { withLockSync } from '../lock-utils.js';

/** One durable task-effect slot across human and charter authorization provenance. */
export function withExecutionIdentityLock<T>(identity: string, action: () => T): T {
  return withLockSync(`execution-identity:${identity}`, action);
}

/** Delivery channels do not partition effect identity; include migrated approvals. */
export function assertNoHumanClaim(identity: string, tenantSlug: string): void {
  if (
    listApprovalRequests().some(
      (record) =>
        record.scope?.tenant_slug === tenantSlug &&
        record.requestedByContext?.executionIdentity === identity &&
        (record.applyClaim || record.applyResult)
    )
  ) {
    throw new Error(
      '[HUMAN_EXECUTION_RECONCILIATION_REQUIRED] Original effect already claimed; changing authorization cannot authorize replay'
    );
  }
}
