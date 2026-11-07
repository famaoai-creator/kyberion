import { assertStoreGrantIssuanceAllowed } from '../authority.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { pathResolver } from '../path-resolver.js';
import {
  withDiscussionRequestCapability,
  DISCUSSION_REQUEST_GRANT_ISSUANCE_RIGHT,
} from '../foundation/discussion-request-capability.js';
import type { DiscussionScope } from './discussion-types.js';

/**
 * Internal synchronous receipt I/O only; the only issuer of the opaque Discussion request grant.
 * Caller first resolves authenticated actor and canonical scope. The grant is the authority
 * (G2: no store role); while it is active the I/O is bound to the selected tenant (no
 * organization) and the caller keeps its own role. The deny-only ceiling survives nested role
 * assumptions; no room/model work runs inside it.
 *
 * Only a process that may hold the issuance right issues the grant (RA-02: Concierge, or a
 * process without SYSTEM_ROLE); every other surface gets [ROLE_ASSUMPTION_DENIED]. A caller
 * already bound to another tenant is refused: a caller-supplied tenant never broadens access.
 */
export function withDiscussionRequestReceiptAccess<T>(
  input: { directory: string; scope: DiscussionScope; write: boolean },
  fn: () => T
): T {
  const tenant = input.scope.tenant_slug;
  if (!tenant || input.scope.tier !== 'confidential')
    throw new Error('[RESOURCE_SCOPE_INVALID] Select an existing tenant for Discussion recovery');
  assertStoreGrantIssuanceAllowed(DISCUSSION_REQUEST_GRANT_ISSUANCE_RIGHT);
  return withDiscussionRequestCapability(
    { directory: pathResolver.toRepoRelative(input.directory), tenant, write: input.write },
    () => {
      const active = resolvePolicyIdentityContext().tenantSlug;
      if (active && active !== tenant)
        throw new Error(
          `[ROLE_TENANT_SCOPE_MISMATCH] Discussion request grant for tenant '${tenant}' used by a caller bound to '${active}'`
        );
      // The grant carries no organization, so none is inherited into the I/O.
      const {
        tenantCleared: _cleared,
        organizationId: _organization,
        ...current
      } = currentExecutionScope() ?? { tenantBound: false };
      return runInExecutionScope({ ...current, tenantBound: true, tenantSlug: tenant }, fn);
    }
  );
}
