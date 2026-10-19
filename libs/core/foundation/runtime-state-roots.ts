/**
 * Durable tier-partitioned state, distinct from append-only metrics ledgers.
 * State roots mirror knowledge-tier permissions for reads AND writes; they
 * are never added to metrics offboarding/compaction merely by registration.
 */
export const PARTITIONED_RUNTIME_STATE_ROOTS = {
  /** Evidence and per-action autonomy overrides; never shared across tenants. */
  autonomy_learning: 'active/shared/runtime/autonomy-learning',
  hearing: 'active/shared/runtime/hearing',
  discussion_create_requests: 'active/shared/runtime/discussion-create-requests',
  /** PG-03 standing grants (governance/grant-store.ts). */
  grants: 'active/shared/runtime/grants',
} as const;
