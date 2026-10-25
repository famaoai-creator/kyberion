/**
 * CD-09: the one "does this customer decision still stand" rule, shared by
 * consumption (`taskProposalStates`, libs/core/customer-decision) and the
 * consumer store guard (`taskProposalRelinkProblem`). A dependency-free leaf
 * over raw ledger JSON, so both sides import it without joining each other's
 * module graph.
 */
type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Ids a later ledger record supersedes (`supersedes` pointers). */
export function supersededDecisionIds(records: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    const supersedes = asRecord(record)?.supersedes;
    if (typeof supersedes === 'string') ids.add(supersedes);
  }
  return ids;
}

/**
 * The one rule (CD-09) for "this ledger record still stands as the customer's
 * decided value of item × key": a decided customer-value record, active, not
 * superseded by a later record, decided on behalf of a customer actor and
 * carrying a value. Consumption (`taskProposalStates`) delivers a released
 * proposal's value only while its decision stands, and the relink guard
 * ({@link taskProposalRelinkProblem}) re-asks a released proposal only when
 * it does not — the same predicate on both sides.
 */
export function isStandingCustomerDecisionRecord(
  record: unknown,
  item: unknown,
  key: unknown,
  supersededIds: ReadonlySet<string>
): boolean {
  const value = asRecord(record);
  const decidedBy = asRecord(value?.decided_by);
  const onBehalfOf = asRecord(decidedBy?.on_behalf_of);
  return Boolean(
    value &&
    typeof value.id === 'string' &&
    value.item === item &&
    value.key === key &&
    value.level === 'customer-value' &&
    value.state === 'decided' &&
    value.status === 'active' &&
    !supersededIds.has(value.id) &&
    typeof onBehalfOf?.actor_id === 'string' &&
    onBehalfOf.actor_id.length > 0 &&
    value.value !== undefined
  );
}
