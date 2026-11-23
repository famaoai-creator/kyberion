/**
 * Charter scope vocabulary — the discriminated union describing who a
 * charter binds (a person, or an organization identified by tenant slug)
 * plus the canonical projections used to branch on it.
 *
 * Lives in foundation so foundation-layer stores and capabilities can
 * branch on charter scopes without importing the domain-level charter
 * aggregate in `governance/accountability-charter.ts`.
 */

export const CHARTER_SCOPE_PERSON = 'person';
export const CHARTER_SCOPE_ORGANIZATION = 'organization';
export const CHARTER_SCOPE_KINDS = [CHARTER_SCOPE_PERSON, CHARTER_SCOPE_ORGANIZATION] as const;
export type CharterScopeKind = (typeof CHARTER_SCOPE_KINDS)[number];
export type CharterScope = { kind: 'person' } | { kind: 'organization'; tenant_slug: string };

export const isPersonalCharterScope = (
  scope: CharterScope
): scope is Extract<CharterScope, { kind: 'person' }> => scope.kind === 'person';

export const charterScopeTenantSlug = (scope: CharterScope): string | undefined =>
  isPersonalCharterScope(scope) ? undefined : scope.tenant_slug;

export const charterScopesEqual = (a: CharterScope, b: CharterScope): boolean =>
  a.kind === b.kind && charterScopeTenantSlug(a) === charterScopeTenantSlug(b);
