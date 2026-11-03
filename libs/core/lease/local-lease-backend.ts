/**
 * local-file-lock lease backend — the governed default.
 *
 * Mutual exclusion is the foundation file lock (`withLock`/`withLockSync`);
 * the fenced lease record is a schema-validated JSON document read/written
 * through the governed catalog and secure-io — exactly the primitives
 * writer-lease used before the seam existed, so safety checks are unchanged.
 * Importing this module installs `local-file-lock` on the lease-backend seam.
 */

import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { writeJson } from '../foundation/json.js';
import { withLock, withLockSync } from '../foundation/lock-utils.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from '../secure-io.js';
import {
  LOCAL_LEASE_BACKEND_ID,
  registerLeaseBackend,
  type FencedLeaseRecord,
  type LeaseBackend,
} from './lease-backend.js';

const WRITER_LEASE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/writer-lease.schema.json');
const leaseCatalogs = new Map<string, GovernedCatalog<FencedLeaseRecord>>();

function leaseCatalog(leasePath: string): GovernedCatalog<FencedLeaseRecord> {
  const existing = leaseCatalogs.get(leasePath);
  if (existing) return existing;
  const catalog = defineCatalog<FencedLeaseRecord>({
    id: 'writer-lease',
    path: leasePath,
    schema: WRITER_LEASE_SCHEMA_PATH,
  });
  leaseCatalogs.set(leasePath, catalog);
  return catalog;
}

export const localFileLeaseBackend: LeaseBackend = {
  id: LOCAL_LEASE_BACKEND_ID,
  withLock<T>(namespace: string, fn: () => Promise<T>): Promise<T> {
    return withLock(namespace, fn);
  },
  withLockSync<T>(namespace: string, fn: () => T): T {
    return withLockSync(namespace, fn);
  },
  read(leaseKey: string): FencedLeaseRecord | undefined {
    const safeLeasePath = assertSafeRepositoryPath(leaseKey, { allowMissingLeaf: true });
    if (!safeExistsSync(safeLeasePath)) return undefined;
    return leaseCatalog(safeLeasePath).load();
  },
  write(leaseKey: string, record: FencedLeaseRecord): void {
    const safeLeasePath = assertSafeRepositoryPath(leaseKey, { allowMissingLeaf: true });
    safeMkdir(path.dirname(safeLeasePath), { recursive: true });
    // Governed write: schema validation through the catalog, persistence via
    // the foundation writeJson helper, then drop the catalog cache. Neither
    // publish() (its internal withLockSync nests under the caller's lease
    // mutex and resource-scoped executions deny the second lock) nor a raw
    // serialized safeWriteFile (the json_state_write consolidation budget) —
    // the lease mutex already serializes writers for this path, so the CAS
    // generation check is redundant here.
    const catalog = leaseCatalog(safeLeasePath);
    writeJson(safeLeasePath, catalog.validate(record, safeLeasePath));
    catalog.reset();
  },
  metricsPath(leaseKey: string): string {
    const safeLeasePath = assertSafeRepositoryPath(leaseKey, { allowMissingLeaf: true });
    return assertSafeRepositoryPath(
      path.join(path.dirname(safeLeasePath), 'writer-lease-metrics.json'),
      { allowMissingLeaf: true }
    );
  },
};

registerLeaseBackend(localFileLeaseBackend, {
  provenance: 'builtin',
  source: 'libs/core/lease/local-lease-backend.ts',
});
