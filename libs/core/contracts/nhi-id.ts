/**
 * NI-01/FD-10: canonical NHI id grammar — extracted from `agent-identity.ts`
 * into its own leaf module so lightweight consumers (e.g. `actor.ts`, which
 * only needs to validate/parse an nhi_id) don't have to pull in the full
 * agent-identity ledger (journal, authority, organization-profile, ...).
 *
 * `agent-identity.ts` re-exports everything here for backward compatibility;
 * this module has no dependency on it or on anything in the
 * secure-io / audit-chain / authority chain, by design — importing it must
 * never re-enter that cycle. (`foundation/scope.ts` is a pure leaf too.)
 *
 * Concept model v2 D3 (Tenant 1:N Organization): the canonical id carries the
 * tenant — `kyberion://agent/<tenant>/<org|_>/<slug>`. `_` in the org segment
 * marks an NHI that belongs to the tenant but to no organization inside it.
 *
 * - Tenant-bound ids are built only by {@link buildNhiId}, which requires a
 *   valid tenant slug and rejects reserved scope names (a tier or partition
 *   name is never a tenant).
 * - `kyberion://agent/_/_/<slug>` ({@link buildTenantlessNhiId}) is the interim
 *   form for identities that belong to no tenant at all (person-scope
 *   onboarding agents, runtimes started with no tenant in scope). An
 *   organization never appears without its tenant.
 * - The pre-D3 shape `kyberion://agent/<org>/<slug>` is a *legacy alias*: it
 *   still parses (and the ledger resolves it to the migrated id) for one
 *   release, then the legacy branch is removed. Nothing mints it any more.
 */
import { isValidTenantSlug } from '../foundation/scope.js';

/** Same grammar as agent-manifest `agentId` validation (`agent-manifest.ts`). */
export const NHI_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export const NHI_ID_PREFIX = 'kyberion://agent/';

/** Org segment of an NHI that belongs to no organization inside its tenant. */
export const NHI_NO_ORGANIZATION = '_';

/** Tenant segment of an NHI that belongs to no tenant (its org segment is `_` too). */
export const NHI_NO_TENANT = '_';

/** Canonical (D3) shape: `kyberion://agent/<tenant>/<org|_>/<slug>` or `kyberion://agent/_/_/<slug>`. */
export const CANONICAL_NHI_ID_PATTERN =
  /^kyberion:\/\/agent\/(?:[a-z][a-z0-9-]{1,30}\/(?:_|[a-z][a-z0-9-]*)|_\/_)\/[a-z][a-z0-9-]*$/;

/** Pre-D3 shape `kyberion://agent/<org>/<slug>` — accepted as an alias for one release. */
export const LEGACY_NHI_ID_PATTERN = /^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/**
 * Every id accepted as an nhi_id during the alias release: the canonical
 * shape or the legacy alias. Stored records (journal, grants, persona
 * bindings) validate against this so pre-migration data still loads.
 */
export const NHI_ID_PATTERN = new RegExp(
  `(?:${CANONICAL_NHI_ID_PATTERN.source})|(?:${LEGACY_NHI_ID_PATTERN.source})`
);

export class AgentIdentityFormatError extends Error {
  constructor(message: string) {
    super(`[agent-identity] ${message}`);
    this.name = 'AgentIdentityFormatError';
  }
}

export interface ParsedNhiId {
  /** Owning tenant; `null` for a tenantless id and for a legacy alias. */
  tenant_slug: string | null;
  /** Organization inside the tenant; `null` for `_`. For a legacy alias, its org segment. */
  organization_id: string | null;
  slug: string;
  /** True for the pre-D3 `kyberion://agent/<org>/<slug>` alias. */
  legacy: boolean;
}

function assertSlug(slug: string): void {
  if (!NHI_SLUG_PATTERN.test(slug)) {
    throw new AgentIdentityFormatError(`invalid slug "${slug}" (must match ${NHI_SLUG_PATTERN})`);
  }
}

/**
 * Build a canonical, tenant-bound nhi_id. The tenant is required and must be
 * a valid, non-reserved tenant slug; an absent organization is written as
 * `_`. Throws {@link AgentIdentityFormatError}.
 */
export function buildNhiId(
  tenantSlug: string,
  organizationId: string | null | undefined,
  slug: string
): string {
  const tenant = typeof tenantSlug === 'string' ? tenantSlug.trim() : '';
  if (!tenant) {
    throw new AgentIdentityFormatError('tenant slug is required for an nhi_id');
  }
  if (!isValidTenantSlug(tenant)) {
    throw new AgentIdentityFormatError(
      `invalid tenant slug "${tenant}" (must match a tenant slug and never be a reserved scope name)`
    );
  }
  const org = organizationId?.trim() || NHI_NO_ORGANIZATION;
  if (org !== NHI_NO_ORGANIZATION && !NHI_SLUG_PATTERN.test(org)) {
    throw new AgentIdentityFormatError(
      `invalid organization id "${org}" (must match ${NHI_SLUG_PATTERN} or be "${NHI_NO_ORGANIZATION}")`
    );
  }
  assertSlug(slug);
  return `${NHI_ID_PREFIX}${tenant}/${org}/${slug}`;
}

/** `kyberion://agent/_/_/<slug>` — an identity that belongs to no tenant (interim). */
export function buildTenantlessNhiId(slug: string): string {
  assertSlug(slug);
  return `${NHI_ID_PREFIX}${NHI_NO_TENANT}/${NHI_NO_ORGANIZATION}/${slug}`;
}

/**
 * Parse an nhi_id (canonical, or the legacy alias for one release); `null`
 * when it is neither. A canonical id whose tenant segment is a reserved scope
 * name is rejected.
 */
export function parseNhiId(nhiId: string): ParsedNhiId | null {
  if (typeof nhiId !== 'string') return null;
  if (CANONICAL_NHI_ID_PATTERN.test(nhiId)) {
    const [tenant, org, slug] = nhiId.slice(NHI_ID_PREFIX.length).split('/');
    if (tenant === NHI_NO_TENANT) {
      return { tenant_slug: null, organization_id: null, slug, legacy: false };
    }
    if (!isValidTenantSlug(tenant)) return null;
    return {
      tenant_slug: tenant,
      organization_id: org === NHI_NO_ORGANIZATION ? null : org,
      slug,
      legacy: false,
    };
  }
  if (LEGACY_NHI_ID_PATTERN.test(nhiId)) {
    const [organizationId, slug] = nhiId.slice(NHI_ID_PREFIX.length).split('/');
    return { tenant_slug: null, organization_id: organizationId, slug, legacy: true };
  }
  return null;
}

/** True for a pre-D3 `kyberion://agent/<org>/<slug>` alias. */
export function isLegacyNhiId(nhiId: string): boolean {
  return parseNhiId(nhiId)?.legacy === true;
}

/**
 * The canonical id a legacy alias migrates to. With a tenant, the org
 * segment is `organizationId` when given, otherwise the legacy org segment —
 * except the removed `'default'` fallback, which becomes `_`. Without a tenant
 * the id becomes tenantless (`_/_`). Returns a canonical input unchanged and
 * `null` for a non-nhi_id. Throws on an invalid tenant.
 */
export function canonicalNhiIdFromLegacy(
  nhiId: string,
  tenantSlug: string | null | undefined,
  organizationId?: string | null
): string | null {
  const parsed = parseNhiId(nhiId);
  if (!parsed) return null;
  if (!parsed.legacy) return nhiId;
  if (!tenantSlug) return buildTenantlessNhiId(parsed.slug);
  const legacyOrg = parsed.organization_id;
  const org =
    organizationId !== undefined ? organizationId : legacyOrg === 'default' ? null : legacyOrg;
  return buildNhiId(tenantSlug, org, parsed.slug);
}

/**
 * Whether `nhiId` names an identity of `organizationId` inside `tenantSlug`.
 * A legacy alias carries no tenant, so it matches on its org segment alone —
 * for the one alias release only.
 */
export function nhiIdBelongsToOrganization(
  nhiId: string,
  tenantSlug: string,
  organizationId: string
): boolean {
  const parsed = parseNhiId(nhiId);
  if (!parsed) return false;
  if (parsed.legacy) return parsed.organization_id === organizationId;
  return parsed.tenant_slug === tenantSlug && parsed.organization_id === organizationId;
}

/** An explicitly empty/invalid canonical selector clears identity, never revives a legacy claim. */
export function resolveClaimedNhiId(
  canonical: string | undefined,
  legacy?: string
): string | undefined {
  const selected = canonical !== undefined ? canonical.trim() : legacy?.trim();
  return selected && parseNhiId(selected) ? selected : undefined;
}
