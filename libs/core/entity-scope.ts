/** Canonical entity scope hierarchy for storage, authorization, and lineage. */
export {
  isReservedScopeName,
  isValidTenantSlug,
  RESERVED_SCOPE_NAMES,
  TENANT_SLUG_PATTERN,
  type ReservedScopeName,
} from './foundation/scope.js';

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
