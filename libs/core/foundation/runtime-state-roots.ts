/**
 * Durable tier-partitioned state, distinct from append-only metrics ledgers.
 * State roots mirror knowledge-tier permissions for reads AND writes; they
 * are never added to metrics offboarding/compaction merely by registration.
 */
export const PARTITIONED_RUNTIME_STATE_ROOTS = {
  hearing: 'active/shared/runtime/hearing',
  discussion_create_requests: 'active/shared/runtime/discussion-create-requests',
} as const;
