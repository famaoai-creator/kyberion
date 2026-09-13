/**
 * FD-07/FD-10: member id grammar — extracted from `member-registry.ts` into
 * its own dependency-free leaf module (same rationale as `nhi-id.ts`): a
 * lightweight consumer that only needs to validate the `user:<member_id>`
 * shape (e.g. `actor.ts`) must not have to pull in the full member registry
 * (catalog-backed profile store, secure-io, tenant-registry, ...).
 *
 * `member-registry.ts` re-exports this for backward compatibility with every
 * existing `member-registry.js` importer.
 */

const MEMBER_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

export function isValidMemberId(value: string): boolean {
  return MEMBER_ID_RE.test(value);
}
