import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import {
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
  TENANT_STORE_LEDGER_ROOTS,
  tenantRuntimePartitionOf,
} from '@agent/core/storage-layout';
import {
  DELEGATION_LEGACY_NOTIFICATIONS_REPO_PATH,
  DELEGATION_LEGACY_RECORD_REPO_DIR,
  DELEGATION_LEGACY_TRACE_REPO_PATH,
  TENANT_RUNTIME_PARTITION_TARGET_KINDS,
} from '@agent/core/scope-offboarding';

/**
 * Tenant-bearing observability store gate (sibling of
 * tenant-runtime-store-registration.test.ts).
 *
 * `active/shared/observability/` is a shared, non-tenant-partitioned tree:
 * tier-guard's tenant check, tenant backup and tenant offboarding do not see a
 * store written there unless it is hand-wired. The delegation trace/records
 * lived there with tenant instruction / context / result text until the owner
 * decided (2026-11-05) to partition them. This gate keeps the next one from
 * landing silently: every observability store a source file names must be
 * classified in `tests/fixtures/tenant-observability-store-inventory.json`.
 *
 * - `tenant_free`: carries no tenant content (say why);
 * - `tenant_namespaced`: tenant content only under `<store>/tenants/<slug>/`,
 *   with the offboarding path that removes it named in the reason;
 * - `legacy_read_only`: a pre-partition copy no code appends to any more,
 *   scrubbed by tenant offboarding (the store's live data is partitioned);
 * - `unclassified_baseline`: recorded when this gate was added; classify it
 *   before it carries tenant content (the list may only shrink).
 */
const rootDir = process.cwd();
const SCAN_ROOTS = ['libs', 'scripts', 'presence', 'satellites', 'plugins'];
const inventoryPath = path.join(
  rootDir,
  'tests',
  'fixtures',
  'tenant-observability-store-inventory.json'
);
const DISPOSITIONS = [
  'tenant_free',
  'tenant_namespaced',
  'legacy_read_only',
  'unclassified_baseline',
] as const;

interface InventoryEntry {
  store: string;
  disposition: (typeof DISPOSITIONS)[number];
  reason: string;
}

function read(filePath: string): string {
  return safeReadFile(filePath, { encoding: 'utf8' }) as string;
}

/** Store name (first segment below observability/) → files naming it. */
function scanStores(): Map<string, Set<string>> {
  const stores = new Map<string, Set<string>>();
  const files = SCAN_ROOTS.flatMap((root) => getAllFiles(path.join(rootDir, root)))
    .map((filePath) => path.relative(rootDir, filePath).split(path.sep).join('/'))
    .filter((relPath) => /\.(ts|tsx|mts)$/u.test(relPath))
    .filter((relPath) => !/\.(test|spec)\.tsx?$/u.test(relPath) && !relPath.endsWith('.d.ts'))
    .filter((relPath) => !/(^|\/)(node_modules|dist|\.next|__tests__)\//u.test(relPath));
  for (const file of files) {
    const source = read(path.join(rootDir, file));
    if (!source.includes('observability/')) continue;
    for (const match of source.matchAll(
      /['"`](?:active\/shared\/)?observability\/([A-Za-z0-9_.-]+)/gu
    )) {
      const store = match[1]!.replace(/\.jsonl?$/u, '');
      if (!store) continue;
      if (!stores.has(store)) stores.set(store, new Set());
      stores.get(store)!.add(file);
    }
  }
  return stores;
}

describe('tenant-bearing observability store registration', () => {
  const inventory = JSON.parse(read(inventoryPath)) as { stores: InventoryEntry[] };
  const stores = scanStores();
  const byStore = new Map(inventory.stores.map((entry) => [entry.store, entry]));

  it('finds the known observability stores (scanner sanity)', () => {
    expect([...stores.keys()]).toEqual(
      expect.arrayContaining(['ops-alerts', 'mission-control', 'delegations'])
    );
  });

  it('classifies every observability store a source file names', () => {
    const unclassified = [...stores.keys()].filter((store) => !byStore.has(store)).sort();
    expect(
      unclassified.map((store) => `${store} (${[...stores.get(store)!].sort().join(', ')})`),
      [
        'tenant-observability-store — these active/shared/observability/<store> paths are not classified;',
        'observability/ is shared and invisible to tier-guard tenant checks, tenant backup and tenant offboarding',
        '| next: put tenant content in a registered partitioned root (storage-layout PARTITIONED_RUNTIME_LEDGER_ROOTS /',
        'PARTITIONED_RUNTIME_STATE_ROOTS, <root>/<tier>/<tenant>/) and offboard it, or classify the store in',
        'tests/fixtures/tenant-observability-store-inventory.json (tenant_free / tenant_namespaced with a reason)',
      ].join(' ')
    ).toEqual([]);
  });

  it('keeps the inventory honest (known dispositions, reasons, matching a store, no growth of the baseline)', () => {
    const problems = inventory.stores
      .filter(
        (entry) =>
          !DISPOSITIONS.includes(entry.disposition) ||
          !entry.reason?.trim() ||
          !stores.has(entry.store)
      )
      .map((entry) => entry.store);
    expect(
      problems,
      'tenant-observability-store inventory — entries with an unknown disposition, no reason, or no matching source reference | next: fix or remove them'
    ).toEqual([]);
    expect(new Set(inventory.stores.map((entry) => entry.store)).size).toBe(
      inventory.stores.length
    );
    // The baseline is a ratchet: new stores must be classified, not baselined.
    const baseline = inventory.stores.filter(
      (entry) => entry.disposition === 'unclassified_baseline'
    ).length;
    expect(baseline, 'unclassified_baseline may only shrink').toBeLessThanOrEqual(16);
  });

  it('keeps the delegation store partitioned and its legacy copies offboarded', () => {
    expect(byStore.get('delegations')?.disposition).toBe('legacy_read_only');
    const root = PARTITIONED_RUNTIME_LEDGER_ROOTS.delegations;
    expect(root.startsWith('active/shared/runtime/')).toBe(true);
    expect(TENANT_STORE_LEDGER_ROOTS.delegations.storeRole).toBe('delegation_record_store');
    expect(TENANT_RUNTIME_PARTITION_TARGET_KINDS.delegations).not.toBe('not_offboarded');
    expect(tenantRuntimePartitionOf(`${root}/confidential/acme/records/x.json`)?.key).toBe(
      'delegations'
    );
    expect(DELEGATION_LEGACY_TRACE_REPO_PATH).toBe('active/shared/observability/delegations.jsonl');
    expect(DELEGATION_LEGACY_RECORD_REPO_DIR).toBe('active/shared/observability/delegations');
    // Only the store module (legacy read fallback) names the legacy paths in
    // live code, via the shared constants — no new writer may target them.
    const delegationRefs = [...(stores.get('delegations') ?? [])].sort();
    expect(delegationRefs).toEqual(['libs/core/foundation/runtime-state-roots.ts']);
  });

  it('keeps the delegation notification queue partitioned and its legacy shared queue offboarded', () => {
    expect(DELEGATION_LEGACY_NOTIFICATIONS_REPO_PATH).toBe(
      'active/shared/runtime/delegations/notifications.jsonl'
    );
    // The queue lives in the delegation partitions, so tier-guard, backup and
    // offboarding see it through the registered delegations ledger root.
    const root = PARTITIONED_RUNTIME_LEDGER_ROOTS.delegations;
    expect(tenantRuntimePartitionOf(`${root}/confidential/acme/notifications.jsonl`)?.key).toBe(
      'delegations'
    );
    // No live code names the shared queue directory except the legacy constant:
    // a new writer must not target it again.
    const refs = SCAN_ROOTS.flatMap((scanRoot) => getAllFiles(path.join(rootDir, scanRoot)))
      .map((filePath) => path.relative(rootDir, filePath).split(path.sep).join('/'))
      .filter((relPath) => /\.(ts|tsx|mts)$/u.test(relPath))
      .filter((relPath) => !/\.(test|spec)\.tsx?$/u.test(relPath) && !relPath.endsWith('.d.ts'))
      .filter((relPath) => !/(^|\/)(node_modules|dist|\.next|__tests__)\//u.test(relPath))
      .filter((relPath) => /runtime\/delegations[/'"`]/u.test(read(path.join(rootDir, relPath))))
      .sort();
    expect(
      refs,
      'delegation notification queue — only foundation/runtime-state-roots.ts may name active/shared/runtime/delegations/ (the read-only legacy queue) | next: enqueue through libs/core/mission/delegation-notifications.ts, which writes the delegation partitions'
    ).toEqual(['libs/core/foundation/runtime-state-roots.ts']);
  });

  it('requires every registered tenant partition root to have an offboarding disposition', () => {
    for (const key of Object.keys(PARTITIONED_RUNTIME_LEDGER_ROOTS)) {
      expect(Object.hasOwn(TENANT_RUNTIME_PARTITION_TARGET_KINDS, key), key).toBe(true);
    }
  });
});
