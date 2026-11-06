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
import { isDiscussionRequestCapability } from './foundation/discussion-request-capability.js';
import { isDotResultStoreCapability } from './foundation/dot-result-store-capability.js';
import { isCustomerDecisionInviteCapability } from './foundation/customer-decision-invite-capability.js';
import {
  currentResourceAccessScope,
  decideResourceAccess,
  type ResourceAccessOperation,
  type ResourceAccessScope,
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
  [TASK_SOURCE_WORKSPACE_ROLE]: (target, operation) =>
    taskSourceWorkspaceIoAllowed(target, operation),
  [PR_PUBLICATION_STORE_ROLE]: (target, operation) =>
    prPublicationResourceAllowed(target, operation),
});

/**
 * Does the active invite capability cover this I/O? Its validator predates
 * appendExact and name prefixes, so neither can enlarge its write ceiling.
 */
function customerDecisionInviteGrantAllows(
  scope: ResourceAccessScope | undefined,
  target: string,
  operation: ResourceAccessOperation
): boolean {
  if (!scope || !isCustomerDecisionInviteCapability(scope)) return false;
  if ((scope.namePrefixExact?.length ?? 0) > 0) return false;
  return decideResourceAccess({ ...scope, appendExact: [] }, target, operation).allowed;
}

/**
 * Does the live Discussion request grant cover this I/O? Its issuer-frozen ceiling
 * (the two records of one request; read-only recovery has no write or mkdir) has no
 * append, metadata or name-prefix grant to enlarge.
 */
function discussionRequestGrantAllows(
  scope: ResourceAccessScope | undefined,
  target: string,
  operation: ResourceAccessOperation
): boolean {
  if (!scope || !isDiscussionRequestCapability(scope)) return false;
  return decideResourceAccess(scope, target, operation).allowed;
}

/**
 * Stores whose active, exact grant is itself the authority for the I/O it
 * covers — no dedicated role (G2). The grant is issued only by the store's
 * governed facade, which also binds the grant's tenant. tier-guard still runs
 * the request ceiling, the tenant scope check and the store's deny-only rules
 * (e.g. the invite tenant/content check) before it asks.
 *
 * - DOT result: an opaque issuer token; possession of a lookalike resolves nothing.
 * - Customer decision invite: the exact structural ceiling of one record (or a
 *   read-only listing). Its former role was a shared core role any in-process
 *   caller could assume with that ceiling, so removing it adds no reach.
 * - Discussion request: an opaque issuer token over the two records of one
 *   request. Its facade checks the issuance right (the former role's RA-02
 *   assumption rule, Concierge only) before it issues.
 */
export function storeGrantAuthorizes(
  target: string,
  operation: ResourceAccessOperation,
  rootDir: string
): boolean {
  const scope = currentResourceAccessScope();
  return (
    isDotResultStoreCapability(scope, { rootDir, target, operation }) ||
    customerDecisionInviteGrantAllows(scope, target, operation) ||
    discussionRequestGrantAllows(scope, target, operation)
  );
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
