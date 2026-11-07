/** Host binding for PR store IO. It confers no execution or decision authority. */
import type { CharterScope } from './accountability-charter.js';
import {
  assertStoreGrantIssuanceAllowed,
  isStoreGrantIssuanceRightRegistered,
} from '../authority.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import {
  currentPrPublicationBinding,
  PR_PUBLICATION_GRANT_ISSUANCE_RIGHT,
  withPrPublicationBinding,
  withPrPublicationStoreGrant,
  type PrPublicationStoreKind,
  type VcsPublicationOperation,
} from '../foundation/pr-publication-store-capability.js';

export type { VcsPublicationOperation };

/**
 * Bind one VCS host run (vcs/publication-host.ts, vcs/governance-host.ts only;
 * import boundary test). The binding confers no I/O by itself.
 */
export function withPrPublicationRuntime<T>(
  scope: CharterScope,
  invocationId: string,
  action: () => T,
  operationId: VcsPublicationOperation = 'vcs:pr_create'
): T {
  return withPrPublicationBinding(scope, invocationId, operationId, action);
}

export function currentVcsPublicationOperation(): VcsPublicationOperation | undefined {
  return currentPrPublicationBinding()?.operationId;
}

export function currentPrPublicationScope(): CharterScope | undefined {
  return currentPrPublicationBinding()?.scope;
}

/**
 * One synchronous, exact store access inside the live binding (the VCS hosts,
 * the charter registry and the external-operation reservation only; import
 * boundary test). The opaque grant ends when `action` returns and is itself the
 * authority for the I/O it covers (G2: no store role).
 *
 * Who may issue it is unchanged: the rule that bounded assuming the former shared
 * core role (RA-02, role-assumption-policy `shared_core_roles`) applies to the
 * issuance right `pr_publication_store`; in an installation whose policy does not name it (it
 * predates the store) the grant only narrows until the installation migration. While the grant is active the caller keeps
 * its own role and persona; an organization publication binds the I/O to the
 * binding's tenant (no organization) and refuses a caller bound to another tenant,
 * a person publication runs unbound (project-scope tenant), as the role assumption did.
 */
export function withPrPublicationStoreAccess<T>(
  kind: PrPublicationStoreKind,
  read: string[],
  write: string[],
  action: () => T
): T {
  // An installation that predates the store (its role-assumption policy does not name the right)
  // gets a grant that narrows but authorizes nothing, as the unregistered role granted nothing.
  const authorizes = isStoreGrantIssuanceRightRegistered(PR_PUBLICATION_GRANT_ISSUANCE_RIGHT);
  return withPrPublicationStoreGrant(kind, read, write, authorizes, () => {
    assertStoreGrantIssuanceAllowed(PR_PUBLICATION_GRANT_ISSUANCE_RIGHT);
    const scope = currentPrPublicationBinding()!.scope;
    const {
      tenantCleared: _cleared,
      organizationId: _organization,
      tenantSlug: _tenant,
      ...current
    } = currentExecutionScope() ?? { tenantBound: false };
    if (scope.kind === 'person')
      return runInExecutionScope({ ...current, tenantBound: false }, action);
    const tenant = scope.tenant_slug;
    const active = resolvePolicyIdentityContext().tenantSlug;
    if (active && active !== tenant)
      throw new Error(
        `[ROLE_TENANT_SCOPE_MISMATCH] PR publication grant for tenant '${tenant}' used by a caller bound to '${active}'`
      );
    return runInExecutionScope({ ...current, tenantBound: true, tenantSlug: tenant }, action);
  });
}
