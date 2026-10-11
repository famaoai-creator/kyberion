/** Pure scope-name primitives shared by storage and contract layers. */
export const RESERVED_SCOPE_NAMES = ['public', 'confidential', 'personal', 'shared'] as const;

export type ReservedScopeName = (typeof RESERVED_SCOPE_NAMES)[number];

export const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export function isReservedScopeName(value: string): value is ReservedScopeName {
  return (RESERVED_SCOPE_NAMES as readonly string[]).includes(value.trim().toLowerCase());
}

export function isValidTenantSlug(value: string): boolean {
  return TENANT_SLUG_PATTERN.test(value) && !isReservedScopeName(value);
}

/** Member identifiers use the tenant slug grammar without reserved-tier exclusions. */
const MEMBER_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export function isValidMemberId(value: string): boolean {
  return MEMBER_ID_PATTERN.test(value);
}

/** Organization/project scope identifiers cannot contain whitespace or path separators. */
const CHRONOS_SCOPE_ID_PATTERN = /^[^\s/]+$/u;

export function isValidChronosScopeId(value: string): boolean {
  return typeof value === 'string' && CHRONOS_SCOPE_ID_PATTERN.test(value);
}
