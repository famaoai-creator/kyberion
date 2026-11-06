/**
 * G2 of the store-catalog guard design: the dedicated store roles whose I/O is
 * allowed only inside an active, exact store grant, in one table instead of a
 * role-name branch at every tier-guard decision. Each entry answers one
 * question — does the active grant of this role's store cover this target and
 * operation? — and fails closed without one.
 *
 * Behaviour is unchanged: tier-guard asked exactly these questions, role by
 * role, for durable state and ledger partitions. The next step replaces the
 * roles themselves with the grant (store-catalog `issuer`).
 */
import {
  DISCUSSION_REQUEST_STORAGE_ROLE,
  isDiscussionRequestCapability,
} from './foundation/discussion-request-capability.js';
import { isDotResultStoreCapability } from './foundation/dot-result-store-capability.js';
import {
  CUSTOMER_DECISION_INVITE_STORE_ROLE,
  isCustomerDecisionInviteCapability,
} from './foundation/customer-decision-invite-capability.js';
import {
  currentResourceAccessScope,
  type ResourceAccessOperation,
} from './foundation/resource-access-scope.js';
import {
  TASK_SOURCE_WORKSPACE_ROLE,
  taskSourceWorkspaceIoAllowed,
} from './foundation/task-source-workspace-capability.js';
import {
  PR_PUBLICATION_STORE_ROLE,
  prPublicationResourceAllowed,
} from './governance/pr-publication-runtime.js';

type StoreGrantCheck = (
  target: string,
  operation: ResourceAccessOperation,
  rootDir: string
) => boolean;

const STORE_GRANTS: Readonly<Record<string, StoreGrantCheck>> = Object.freeze({
  [DISCUSSION_REQUEST_STORAGE_ROLE]: () =>
    isDiscussionRequestCapability(currentResourceAccessScope()),
  [CUSTOMER_DECISION_INVITE_STORE_ROLE]: () =>
    isCustomerDecisionInviteCapability(currentResourceAccessScope()),
  [TASK_SOURCE_WORKSPACE_ROLE]: (target, operation) =>
    taskSourceWorkspaceIoAllowed(target, operation),
  [PR_PUBLICATION_STORE_ROLE]: (target, operation) =>
    prPublicationResourceAllowed(target, operation),
});

/**
 * Stores whose active, exact grant is itself the authority for the I/O it
 * covers — no dedicated role (G2). The grant is issued only by the store's
 * governed facade, which also binds the grant's tenant; possession alone
 * resolves nothing. tier-guard still runs the request ceiling and the tenant
 * scope check before it asks.
 */
export function storeGrantAuthorizes(
  target: string,
  operation: ResourceAccessOperation,
  rootDir: string
): boolean {
  return isDotResultStoreCapability(currentResourceAccessScope(), { rootDir, target, operation });
}

/** Does the active grant of `role`'s dedicated store cover this I/O? False for any other role. */
export function dedicatedStoreGrantAllows(
  role: string | undefined,
  target: string,
  operation: ResourceAccessOperation,
  rootDir: string
): boolean {
  const check = role ? STORE_GRANTS[role] : undefined;
  return check ? check(target, operation, rootDir) : false;
}
