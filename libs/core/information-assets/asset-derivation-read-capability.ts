import { AsyncLocalStorage } from 'node:async_hooks';
import { registerStoreGrant } from '../foundation/store-grant-registry.js';
import type { ResourceAccessOperation } from '../foundation/resource-access-scope.js';
import { PARTITIONED_RUNTIME_LEDGER_ROOTS } from '../foundation/runtime-state-roots.js';
import type { AssetDerivationRecord, DerivationCustody } from './asset-derivation.js';

const RECEIPT_FILE = `${PARTITIONED_RUNTIME_LEDGER_ROOTS.asset_derivations}/system/derivations.jsonl`;
const grants = new AsyncLocalStorage<object>();
const issued = new WeakSet<object>();
type Entry = { record: AssetDerivationRecord; partition: DerivationCustody };
type Snapshot = { root: string; entries: Entry[] };
const snapshots = new AsyncLocalStorage<Snapshot>();
const issuedSnapshots = new WeakSet<Snapshot>();

function live(): boolean {
  const grant = grants.getStore();
  return !!grant && issued.has(grant);
}

function allowed(target: string, operation: ResourceAccessOperation): boolean {
  return (
    live() &&
    (operation === 'read'
      ? target === RECEIPT_FILE
      : operation === 'metadata' &&
        (target === RECEIPT_FILE || target === '' || RECEIPT_FILE.startsWith(target + '/')))
  );
}

function synchronous<T>(action: () => T): T {
  const result = action();
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error('[DERIVATION_READ_SCOPE] lineage read facade is synchronous only');
  }
  return result;
}

/** Import-restricted to asset-derivation.ts. Its caller authorizes the own
 * index before entering; only the receipt reader runs with an exact IO grant.
 * The planner runs after revocation and exposes filtered paths, never raw rows.
 */
export function withAssetDerivationReceiptSnapshot<T>(
  root: string,
  custody: DerivationCustody,
  own: AssetDerivationRecord[],
  readReceipts: () => AssetDerivationRecord[],
  action: () => T,
  canonical: boolean
): T {
  const grant = Object.freeze({});
  issued.add(grant);
  let receipts: AssetDerivationRecord[];
  try {
    receipts = canonical
      ? grants.run(grant, () => synchronous(readReceipts))
      : synchronous(readReceipts);
  } finally {
    issued.delete(grant);
  }
  const snapshot: Snapshot = {
    root,
    entries: [
      ...receipts
        .filter((record) => custody.kind !== 'tenant' || record.taint.tenants.includes(custody.ref))
        .map((record) => ({ record, partition: { kind: 'system' as const } })),
      ...own.map((record) => ({ record, partition: custody })),
    ],
  };
  issuedSnapshots.add(snapshot);
  try {
    return snapshots.run(snapshot, () => synchronous(action));
  } finally {
    issuedSnapshots.delete(snapshot);
  }
}

/** Private planner context: only a currently issued synchronous snapshot is visible. */
export function currentAssetDerivationReceiptSnapshot(root: string): Entry[] | undefined {
  const snapshot = snapshots.getStore();
  return snapshot && issuedSnapshots.has(snapshot) && snapshot.root === root
    ? snapshot.entries
    : undefined;
}

registerStoreGrant({
  id: 'asset-derivation',
  active: live,
  pathAllowed: allowed,
  authorizes: allowed,
  narrowing: ({ relativePath, operation }) =>
    !live() || allowed(relativePath, operation)
      ? null
      : '[DERIVATION_READ_SCOPE] exact read-only producer receipt capability required',
});
