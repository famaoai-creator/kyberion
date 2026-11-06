import type { ResourceAccessOperation, ResourceAccessScope } from './resource-access-scope.js';
import {
  ARCHIVED_MISSION_STATE_READER_ROLE,
  isArchivedMissionStateCapability,
} from './archived-mission-state-capability.js';
import type { WriteContent } from './customer-decision-record-content.js';
import { storeGrantNarrowingDenial, storeGrantRule } from './store-grant-registry.js';
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
 *   - content-checked stores: every write inside a live consumer-lock or
 *     milestone grant (G2: no role) is checked against the record on disk;
 *   - an active customer decision invite capability (G2: it replaced the
 *     `customer_decision_invite_store` role, whatever role the caller holds):
 *     writes / mkdirs only for a registered active tenant, except a
 *     content-checked revoke of an existing record.
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
  // G2: only the live personal approval owner window (no role) reaches an owner partition
  // (G3: asked through the store grant registry; an unloaded window module admits nothing).
  if (
    /(?:^|\/)tenant-approvals\/personal\/shared\/owners(?:\/|$)/u.test(relativePath) &&
    storeGrantRule('personal-approval')?.pathAllowed?.(relativePath, input.operation) !== true
  )
    return '[PERSONAL_APPROVAL_SCOPE_REQUIRED] Personal owner partition requires exact owner IO';
  // G2/G3: the live store grants narrow every I/O made inside them (no role), in registry order:
  // the personal approval window, the task source workspace window (its liveness check runs
  // with the window suspended, so it is never narrowed), the invite capability's tenant/content
  // check, and the content checks of every write inside a consumer-lock or milestone grant.
  const grantDenial = storeGrantNarrowingDenial(
    [
      'personal-approval',
      'task-source-workspace',
      'customer-decision-invite',
      'customer-decision-consumer',
      'customer-decision-milestone',
    ],
    {
      relativePath,
      operation: input.operation,
      candidates: () => [relativePath],
      scope: input.scope,
      content: input.content,
      readRepoFile: input.readRepoFile,
    }
  );
  if (grantDenial) return grantDenial;
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
    return '[CUSTOMER_CHANNEL_BINDING_STORE_SCOPE] The binding store writes only knowledge/confidential/<tenant>/connections/channel-bindings.json';
  if (
    role === ARCHIVED_MISSION_STATE_READER_ROLE &&
    (operation === 'write' ||
      operation === 'mkdir' ||
      !isArchivedMissionStateCapability(input.scope))
  )
    return '[RESOURCE_SCOPE_REQUIRED] Archived mission state reads require their exact read-only capability';
  return null;
}
