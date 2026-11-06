/**
 * G2 of the store-catalog guard design: names of former dedicated store roles
 * whose store grant is now itself the authority. Each name survives only as the
 * grant's issuance right (role-assumption-policy `shared_core_roles` /
 * `may_assume`, checked by authority.ts assertStoreGrantIssuanceAllowed). It is
 * never an assumable authority role (authority.ts refuses the assumption), and a
 * process that still runs as one through SYSTEM_ROLE / MISSION_ROLE env gets no
 * I/O at all (tier-guard), as the former role granted nothing outside its grant.
 */
export const RETIRED_STORE_ROLE_NAMES: ReadonlySet<string> = new Set([
  'pr_publication_store',
  'autonomy_learning_store',
]);
