/**
 * QM-10 reusable contract harness for governed JSON record stores.
 *
 * Stores differ in their persistence APIs, but the safety contract is shared:
 * a create is observable through list, creates receive distinct ids, and a
 * record can be loaded again by its canonical id. Adapters keep this helper
 * independent from any particular store or test framework.
 */
export interface JsonRecordStoreContractAdapter<T> {
  create(label: string): T;
  list(): T[];
  id(record: T): string;
  load(id: string): T | null;
}

export interface JsonRecordStoreContractResult {
  firstId: string;
  secondId: string;
  listedIds: string[];
  loadedFirst: boolean;
  loadedSecond: boolean;
}

export function exerciseJsonRecordStoreContract<T>(
  adapter: JsonRecordStoreContractAdapter<T>
): JsonRecordStoreContractResult {
  const first = adapter.create('contract-first');
  const second = adapter.create('contract-second');
  const firstId = adapter.id(first);
  const secondId = adapter.id(second);
  const listedIds = adapter.list().map((record) => adapter.id(record));
  return {
    firstId,
    secondId,
    listedIds,
    loadedFirst: adapter.load(firstId) !== null,
    loadedSecond: adapter.load(secondId) !== null,
  };
}
