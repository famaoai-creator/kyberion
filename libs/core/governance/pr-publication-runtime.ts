/** Host binding for PR store IO. It confers no execution or decision authority. */
import type { CharterScope } from './accountability-charter.js';
import {
  currentPrPublicationBinding,
  prPublicationResourceAllowed,
  withPrPublicationBinding,
  withPrPublicationStoreGrant,
  type PrPublicationStoreKind,
  type VcsPublicationOperation,
} from '../foundation/pr-publication-store-capability.js';

export const PR_PUBLICATION_STORE_ROLE = 'pr_publication_store';
export type { VcsPublicationOperation };
export { prPublicationResourceAllowed };

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
 * boundary test). The grant is opaque and ends when `action` returns.
 */
export function withPrPublicationStoreAccess<T>(
  kind: PrPublicationStoreKind,
  read: string[],
  write: string[],
  action: () => T
): T {
  return withPrPublicationStoreGrant(kind, read, write, action);
}
