/**
 * Test entry for a name that may be an Authority Role or a declared store
 * grant (S4 slice 3): a store grant is opened the way its facade opens it
 * (`withStoreGrant`, with the grant's declared persona), anything else is
 * assumed as a role. Tests only — production code calls the one it means.
 */
import {
  withExecutionContext,
  withExecutionContextAsync,
  withStoreGrant,
  withStoreGrantAsync,
} from '../authority.js';
import { isDeclaredStoreGrantName } from '../foundation/declared-store-grant.js';
import type { ExecutionIdentityBinding } from '../foundation/execution-scope.js';
import type { BaseRole } from '../types.js';

export function asRoleOrGrant<T>(
  role: string,
  fn: () => T,
  persona?: BaseRole,
  tenantSlug?: string,
  organizationId?: string,
  identity?: ExecutionIdentityBinding
): T {
  return isDeclaredStoreGrantName(role)
    ? withStoreGrant(role, fn, { tenantSlug, organizationId, identity })
    : withExecutionContext(role, fn, persona, tenantSlug, organizationId, identity);
}

export function asRoleOrGrantAsync<T>(
  role: string,
  fn: () => Promise<T> | T,
  persona?: BaseRole,
  tenantSlug?: string,
  organizationId?: string,
  identity?: ExecutionIdentityBinding
): Promise<T> {
  return isDeclaredStoreGrantName(role)
    ? withStoreGrantAsync(role, fn, { tenantSlug, organizationId, identity })
    : withExecutionContextAsync(role, fn, persona, tenantSlug, organizationId, identity);
}
