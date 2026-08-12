/** Canonical entity scope hierarchy for storage, authorization, and lineage. */
export const ENTITY_SCOPE_HIERARCHY = [
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
  'session',
] as const;

export type EntityScopeKey = (typeof ENTITY_SCOPE_HIERARCHY)[number];

/**
 * Names that identify a tier or a storage partition, never a tenant.
 *
 * Tier and tenant are orthogonal axes, so a value of one must never satisfy the
 * other. `shared` is called out explicitly in the architecture doc — "it is not
 * a tenant and must not satisfy the required `tenant_slug` field for
 * confidential data" — and the same reasoning applies to the tier names.
 *
 * This is enforced because the violation is silent and self-propagating: a
 * `tenant_slug` of `public` passes every syntactic slug check, and any writer
 * that partitions storage by slug then materialises a directory named after a
 * tier. That directory is subsequently read back as if a tenant existed
 * (EG-14).
 */
export const RESERVED_SCOPE_NAMES = ['public', 'confidential', 'personal', 'shared'] as const;

export const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export type ReservedScopeName = (typeof RESERVED_SCOPE_NAMES)[number];

/** True when `value` names a tier or storage partition rather than a tenant. */
export function isReservedScopeName(value: string): value is ReservedScopeName {
  return (RESERVED_SCOPE_NAMES as readonly string[]).includes(value.trim().toLowerCase());
}

/** True only for a syntactically valid tenant name that is not a tier/partition. */
export function isValidTenantSlug(value: string): boolean {
  return TENANT_SLUG_PATTERN.test(value) && !isReservedScopeName(value);
}
