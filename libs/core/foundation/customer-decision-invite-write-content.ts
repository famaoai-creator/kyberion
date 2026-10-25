import { caseRecordCanonicalJson } from './customer-decision-milestone-capability.js';
import type { WriteContent } from './customer-decision-write-content.js';
import { isRecord } from './primitives.js';
import type { ResourceAccessOperation } from './resource-access-scope.js';
import { isValidTenantSlug } from './scope.js';

/**
 * CD-10: the invite store (`customer_decision_invite_store`) writes only for a
 * tenant that is registered and active (`knowledge/personal/tenants/<t>.json`,
 * matching `tenant_slug`, `status === 'active'` — the rule of tier-guard
 * `isRegisteredActiveTenant` and `isActiveCustomerTenant`). For any other
 * tenant the only write allowed is a revoke of an existing record; every
 * mkdir is refused, so no partition is ever created for it.
 */
export const CD_INVITE_TENANT_NOT_REGISTERED = '[CD_INVITE_TENANT_NOT_REGISTERED]';

/** The guard's raw registry read; any failure is "not active". */
export function isRegisteredActiveTenantProfile(
  tenantSlug: string,
  readRepoFile: (repoRelative: string) => string | undefined
): boolean {
  if (!isValidTenantSlug(tenantSlug)) return false;
  try {
    const raw = readRepoFile(`knowledge/personal/tenants/${tenantSlug}.json`);
    if (raw === undefined) return false;
    const profile: unknown = JSON.parse(raw);
    return isRecord(profile) && profile.tenant_slug === tenantSlug && profile.status === 'active';
  } catch {
    return false;
  }
}

function parseRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is `next` exactly `previous` plus a revoke (`revoked_at` and, optionally,
 * `revoked_reason`, both non-empty strings, neither present before)?
 */
export function isRevokeOnlyInviteChange(previous: unknown, next: unknown): boolean {
  if (!isRecord(previous) || !isRecord(next)) return false;
  if (previous.revoked_at !== undefined || previous.revoked_reason !== undefined) return false;
  const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!nonEmpty(next.revoked_at)) return false;
  if (next.revoked_reason !== undefined && !nonEmpty(next.revoked_reason)) return false;
  const { revoked_at: _at, revoked_reason: _reason, ...rest } = next;
  void _at;
  void _reason;
  return caseRecordCanonicalJson(rest) === caseRecordCanonicalJson(previous);
}

/**
 * The refusal reason of an invite store write / mkdir, or null when allowed.
 * `tenantSlug` is the tenant of the role's capability; reads are not checked.
 */
export function customerDecisionInviteWriteDenial(input: {
  tenantSlug: string | undefined;
  relativePath: string;
  operation: ResourceAccessOperation;
  content: WriteContent | undefined;
  readRepoFile: (repoRelative: string) => string | undefined;
}): string | null {
  const { tenantSlug, relativePath, operation, content, readRepoFile } = input;
  if (operation !== 'write' && operation !== 'mkdir') return null;
  if (tenantSlug && isRegisteredActiveTenantProfile(tenantSlug, readRepoFile)) return null;
  const refused = `${CD_INVITE_TENANT_NOT_REGISTERED} the tenant is not a registered active tenant, so the invite store may only revoke an existing invite`;
  if (operation !== 'write' || content === undefined) return refused;
  let previous: Record<string, unknown> | undefined;
  try {
    previous = parseRecord(readRepoFile(relativePath));
  } catch {
    return refused;
  }
  const next = parseRecord(typeof content === 'string' ? content : content.toString('utf8'));
  return isRevokeOnlyInviteChange(previous, next) ? null : refused;
}
