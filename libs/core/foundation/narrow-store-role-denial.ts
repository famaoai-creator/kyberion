import type { ResourceAccessOperation, ResourceAccessScope } from './resource-access-scope.js';
import {
  PERSONAL_APPROVAL_STORE_ROLE,
  personalApprovalIoAllowed,
} from './personal-approval-io-capability.js';
import {
  TASK_SOURCE_WORKSPACE_ROLE,
  taskSourceWorkspaceIoAllowed,
} from './task-source-workspace-capability.js';
import {
  ARCHIVED_MISSION_STATE_READER_ROLE,
  isArchivedMissionStateCapability,
} from './archived-mission-state-capability.js';
import { CUSTOMER_DECISION_INVITE_STORE_ROLE } from './customer-decision-invite-capability.js';
import { customerDecisionInviteWriteDenial } from './customer-decision-invite-write-content.js';
import {
  CONTENT_CHECKED_ROLES,
  customerDecisionWriteContentDenial,
  type WriteContent,
} from './customer-decision-write-content.js';
import {
  CUSTOMER_CHANNEL_BINDING_STORE_ROLE,
  customerChannelBindingStorePathAllowed,
} from './customer-channel-binding-store-capability.js';
import {
  DELIVERABLE_INBOX_ENTRIES_PATH,
  DELIVERABLE_INBOX_WRITER_ROLE,
  deliverableInboxWriteProblem,
  deliverableInboxWriterPathAllowed,
} from './deliverable-inbox-writer-capability.js';

/**
 * Tier-guard rules of the narrow store roles added by the customer decision
 * hardening (deny-only; the policy grant still applies after them):
 *   - `deliverable_inbox_writer`: writes / mkdirs only the inbox and its lock,
 *     and may only append to the shared entries file;
 *   - `archived_mission_state_reader`: reads only under its exact capability;
 *   - `customer_channel_binding_store`: writes / mkdirs only the bindings file;
 *   - content-checked roles (consumer / milestone store): every write is
 *     checked against the record on disk;
 *   - `customer_decision_invite_store`: writes / mkdirs only for a registered
 *     active tenant, except a content-checked revoke of an existing record.
 * Returns the refusal reason, or null.
 */
export function narrowStoreRoleDenial(input: {
  role: string | undefined;
  relativePath: string;
  operation: ResourceAccessOperation;
  scope: ResourceAccessScope | undefined;
  content: WriteContent | undefined;
  /** The guard's own raw read of a repo-relative file (undefined when absent). */
  readRepoFile: (repoRelative: string) => string | undefined;
}): string | null {
  const { role, relativePath } = input;
  // `shared` is the personal storage marker, never a tenant credential. An
  // unbound tenant-store reader must not reinterpret this owner namespace.
  if (
    /(?:^|\/)tenant-approvals\/personal\/shared\/owners(?:\/|$)/u.test(relativePath) &&
    (role !== PERSONAL_APPROVAL_STORE_ROLE ||
      !personalApprovalIoAllowed(relativePath, input.operation))
  )
    return '[PERSONAL_APPROVAL_SCOPE_REQUIRED] Personal owner partition requires exact owner IO';
  if (
    role === PERSONAL_APPROVAL_STORE_ROLE &&
    !personalApprovalIoAllowed(relativePath, input.operation)
  )
    return '[PERSONAL_APPROVAL_SCOPE_REQUIRED] Exact personal owner IO window required';
  if (
    role === TASK_SOURCE_WORKSPACE_ROLE &&
    !taskSourceWorkspaceIoAllowed(relativePath, input.operation)
  )
    return '[TASK_SOURCE_SCOPE_DENIED] Exact live workspace IO capability required';
  // Append must retain every pre-existing write/content restriction, never fall through
  // a metadata/read branch merely because the resource ceiling distinguishes the verb.
  const operation = input.operation === 'append' ? 'write' : input.operation;
  if (!role) return null;
  if (
    role === DELIVERABLE_INBOX_WRITER_ROLE &&
    !deliverableInboxWriterPathAllowed(relativePath, operation)
  )
    return '[DELIVERABLE_INBOX_WRITER_SCOPE] The inbox writer writes only the deliverable inbox and its own lock';
  if (
    role === DELIVERABLE_INBOX_WRITER_ROLE &&
    operation === 'write' &&
    relativePath === DELIVERABLE_INBOX_ENTRIES_PATH
  ) {
    if (input.content === undefined)
      return '[DELIVERABLE_INBOX_WRITE_REFUSED] the inbox writer writes only whole entries files whose content the guard checks';
    let previous: string | undefined;
    try {
      previous = input.readRepoFile(relativePath);
    } catch {
      return '[DELIVERABLE_INBOX_WRITE_REFUSED] the inbox on disk could not be read for the content check';
    }
    const next = typeof input.content === 'string' ? input.content : input.content.toString('utf8');
    const problem = deliverableInboxWriteProblem(previous, next);
    if (problem) return problem;
  }
  if (
    role === CUSTOMER_CHANNEL_BINDING_STORE_ROLE &&
    !customerChannelBindingStorePathAllowed(relativePath, operation)
  )
    return '[CUSTOMER_CHANNEL_BINDING_STORE_SCOPE] The binding store writes only customer/<tenant>/connections/channel-bindings.json';
  if (
    role === ARCHIVED_MISSION_STATE_READER_ROLE &&
    (operation === 'write' ||
      operation === 'mkdir' ||
      !isArchivedMissionStateCapability(input.scope))
  )
    return '[RESOURCE_SCOPE_REQUIRED] Archived mission state reads require their exact read-only capability';
  if (role === CUSTOMER_DECISION_INVITE_STORE_ROLE) {
    const inviteDenial = customerDecisionInviteWriteDenial({
      tenantSlug: input.scope?.tenantSlug,
      relativePath,
      operation,
      content: input.content,
      readRepoFile: input.readRepoFile,
    });
    if (inviteDenial) return inviteDenial;
  }
  if (operation === 'write' && CONTENT_CHECKED_ROLES.has(role))
    return customerDecisionWriteContentDenial(
      role,
      relativePath,
      input.content,
      input.scope?.metadataExact?.[0],
      input.readRepoFile
    );
  return null;
}
