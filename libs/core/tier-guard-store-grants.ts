/**
 * G2 of the store-catalog guard design: the dedicated store grants that are
 * themselves the authority for the I/O they cover, asked in one place
 * (`storeGrantAuthorizes`) instead of a role-name branch at every tier-guard
 * decision. Every former dedicated store role in this table has been replaced
 * by its grant, so the role-keyed table (`dedicatedStoreGrantAllows`) is gone.
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
import { taskSourceWorkspaceGrantAllows } from './foundation/task-source-workspace-capability.js';
import { prPublicationGrantAuthorizes } from './foundation/pr-publication-store-capability.js';
import { autonomyLearningGrantAllows } from './foundation/autonomy-learning-capability.js';
import { pipelineJournalGrantAllows } from './foundation/pipeline-journal-capability.js';
import { credentialMaterialGrantAllows } from './foundation/credential-material-capability.js';
import { memoryProvenanceGrantAllows } from './knowledge/memory-provenance-capability.js';
import { personCharterGrantAuthorizes } from './governance/person-charter-runtime.js';
import { customerDecisionConsumerGrantAllows } from './foundation/customer-decision-consumer-capability.js';

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
 * - Task source workspace: the module-private window over one live workspace file.
 * - PR publication: the module-private grant of one synchronous store access of
 *   a VCS host run (one of five kinds, one store each), inside its exact ceiling
 *   and the roots the former role's policy grant covered. Its facade checks the
 *   issuance right (the former shared core role's RA-02 rule) before it issues.
 * - Autonomy learning: the opaque issuer grant over one tenant partition (outcomes ledger,
 *   overrides, their rewrite siblings and archive), under the store root. Its facade checks the
 *   issuance right (the former shared core role's RA-02 rule) before it issues.
 * - Pipeline journal: the opaque issuer grant over one confidential library run journal of the
 *   caller's own tenant (journal, writer lease, lease metrics), under the store root. Its facade
 *   checks the issuance right (the former shared core role's RA-02 rule) before it issues.
 * - Credential material: the opaque issuer grant of one allocated connection file read by the
 *   admitted allocation broker (and its ancestors' metadata). Its facade checks the issuance right
 *   (the former shared core role's RA-02 rule) before it issues.
 * - Memory provenance: the module-private synchronous grant of one exact lineage state read, under
 *   the roots the former reader role covered. Its facade checks the issuance right (the former
 *   shared core role's RA-02 rule) and the tenant / owner binding before it issues.
 * - Person charter: the module-private grant of one synchronous registry access or canonical personal
 *   reservation inside the installed owner binding, under the roots the former role covered. Its
 *   facade checks the issuance right (the former shared core role's RA-02 rule) before the I/O.
 * - Customer decision consumer lock: the opaque issuer grant of one consumer-lock operation of one
 *   case (CD-09), under the tenant decisions root; its writes are content-checked
 *   (narrow-store-role-denial). Its facade checks the issuance right before it issues.
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
    discussionRequestGrantAllows(scope, target, operation) ||
    taskSourceWorkspaceGrantAllows(target, operation) ||
    prPublicationGrantAuthorizes(target, operation) ||
    autonomyLearningGrantAllows(target, operation) ||
    pipelineJournalGrantAllows(target, operation) ||
    credentialMaterialGrantAllows(target, operation) ||
    memoryProvenanceGrantAllows(target, operation) ||
    personCharterGrantAuthorizes(target, operation) ||
    customerDecisionConsumerGrantAllows(target, operation)
  );
}
