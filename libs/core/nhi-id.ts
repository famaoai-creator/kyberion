/**
 * NI-01/FD-10: canonical NHI id grammar — extracted from `agent-identity.ts`
 * into its own leaf module so lightweight consumers (e.g. `actor.ts`, which
 * only needs to validate/parse an nhi_id) don't have to pull in the full
 * agent-identity ledger (journal, authority, organization-profile, ...).
 *
 * `agent-identity.ts` re-exports everything here for backward compatibility;
 * this module has no dependency on it or on anything in the
 * secure-io / audit-chain / authority chain, by design — importing it must
 * never re-enter that cycle.
 */

/** Same grammar as agent-manifest `agentId` validation (`agent-manifest.ts`). */
export const NHI_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export const NHI_ID_PREFIX = 'kyberion://agent/';

export const NHI_ID_PATTERN = /^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

export class AgentIdentityFormatError extends Error {
  constructor(message: string) {
    super(`[agent-identity] ${message}`);
    this.name = 'AgentIdentityFormatError';
  }
}

/** Build a canonical nhi_id. Throws {@link AgentIdentityFormatError} on invalid org/slug. */
export function buildNhiId(organizationId: string, slug: string): string {
  if (!NHI_SLUG_PATTERN.test(organizationId)) {
    throw new AgentIdentityFormatError(
      `invalid organization id "${organizationId}" (must match ${NHI_SLUG_PATTERN})`
    );
  }
  if (!NHI_SLUG_PATTERN.test(slug)) {
    throw new AgentIdentityFormatError(`invalid slug "${slug}" (must match ${NHI_SLUG_PATTERN})`);
  }
  return `${NHI_ID_PREFIX}${organizationId}/${slug}`;
}

/** Parse a canonical nhi_id back into org + slug; `null` when not a valid nhi_id. */
export function parseNhiId(nhiId: string): { organization_id: string; slug: string } | null {
  if (!NHI_ID_PATTERN.test(nhiId)) return null;
  const [organizationId, slug] = nhiId.slice(NHI_ID_PREFIX.length).split('/');
  return { organization_id: organizationId, slug };
}
