/**
 * Governed facade of the customer decision consumer-lock grant (CD-09, G2 of the
 * store-catalog guard design): the mission decision lock and the operator re-ask
 * facade open the exact consumer-lock grant only through here (import boundary
 * test tests/customer-decision-consumer-capability-boundary.test.ts).
 *
 * The grant is the authority for the I/O it covers (no store role), and every write
 * inside it is held to the CD-09 content rules by the tier guard. Who may issue it is
 * unchanged: the rule that bounded assuming the former shared core role (RA-02) applies
 * to the issuance right `customer_decision_consumer_store`. While it is active the
 * caller keeps its own role and persona, bound to the case's tenant (no organization),
 * as the tenant-bound role assumption bound it; a caller bound to another tenant is
 * refused.
 */
import { assertStoreGrantIssuanceAllowed } from '../authority.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import {
  CUSTOMER_DECISION_CONSUMER_GRANT_ISSUANCE_RIGHT,
  withCustomerDecisionConsumerCapability,
  type CustomerDecisionConsumerAccess,
} from '../foundation/customer-decision-consumer-capability.js';

/** Run `fn` inside the exact consumer-lock grant for `access` (case-relative) on `caseDir`. */
export function withCustomerDecisionConsumerGrant<T>(
  tenantSlug: string,
  caseDir: string,
  access: CustomerDecisionConsumerAccess,
  fn: () => T
): T {
  assertStoreGrantIssuanceAllowed(CUSTOMER_DECISION_CONSUMER_GRANT_ISSUANCE_RIGHT);
  return withCustomerDecisionConsumerCapability(tenantSlug, caseDir, access, () => {
    const active = resolvePolicyIdentityContext().tenantSlug;
    if (active && active !== tenantSlug)
      throw new Error(
        `[ROLE_TENANT_SCOPE_MISMATCH] customer decision consumer grant for tenant '${tenantSlug}' used by a caller bound to '${active}'`
      );
    const {
      tenantCleared: _cleared,
      organizationId: _organization,
      ...current
    } = currentExecutionScope() ?? { tenantBound: false };
    return runInExecutionScope({ ...current, tenantBound: true, tenantSlug }, fn);
  });
}
