/**
 * Charter scope vocabulary — the discriminated union describing who a
 * charter binds (a person, an organization identified by tenant slug, or one
 * approved pipeline Run Manifest inside a tenant) plus the canonical
 * projections used to branch on it.
 *
 * Lives in foundation so foundation-layer stores and capabilities can
 * branch on charter scopes without importing the domain-level charter
 * aggregate in `governance/accountability-charter.ts`.
 */

export const CHARTER_SCOPE_PERSON = 'person';
export const CHARTER_SCOPE_ORGANIZATION = 'organization';
/**
 * Issued only from a human-approved pipeline Run Manifest. Not an authorable
 * kind (absent from CHARTER_SCOPE_KINDS): forms and onboarding never mint it.
 */
export const CHARTER_SCOPE_RUN_MANIFEST = 'run_manifest';
export const CHARTER_SCOPE_KINDS = [CHARTER_SCOPE_PERSON, CHARTER_SCOPE_ORGANIZATION] as const;
export type CharterScopeKind = (typeof CHARTER_SCOPE_KINDS)[number];
export type CharterScope =
  | { kind: 'person' }
  | { kind: 'organization'; tenant_slug: string }
  | { kind: 'run_manifest'; tenant_slug: string; manifest_hash: string };
/** Scopes a human may author directly (forms, onboarding, standing grants). */
export type AuthorableCharterScope = Exclude<CharterScope, { kind: 'run_manifest' }>;

/** Run Manifest hashes are bare lowercase SHA-256 hex digests. */
export const RUN_MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/;

export const isPersonalCharterScope = (
  scope: CharterScope
): scope is Extract<CharterScope, { kind: 'person' }> => scope.kind === 'person';

export const isOrganizationCharterScope = (
  scope: CharterScope
): scope is Extract<CharterScope, { kind: 'organization' }> => scope.kind === 'organization';

export const isRunManifestCharterScope = (
  scope: CharterScope
): scope is Extract<CharterScope, { kind: 'run_manifest' }> => scope.kind === 'run_manifest';

/** Scopes whose charter lives in (and is confined to) one tenant. */
export const isTenantCharterScope = (
  scope: CharterScope
): scope is Exclude<CharterScope, { kind: 'person' }> => scope.kind !== 'person';

export const charterScopeTenantSlug = (scope: CharterScope): string | undefined =>
  isPersonalCharterScope(scope) ? undefined : scope.tenant_slug;

export const charterScopesEqual = (a: CharterScope, b: CharterScope): boolean =>
  a.kind === b.kind &&
  charterScopeTenantSlug(a) === charterScopeTenantSlug(b) &&
  (isRunManifestCharterScope(a) ? a.manifest_hash : undefined) ===
    (isRunManifestCharterScope(b) ? b.manifest_hash : undefined);
