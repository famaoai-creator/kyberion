import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';
import { resolveAssetAddress } from '@agent/core/foundation/asset-address';
import { detectTier } from '@agent/core/tier-guard';
import type { AssetStoreDeclaration } from '@agent/core/contracts/asset-scope';

/**
 * The store catalog (the asset address) and tier-guard must agree on every
 * tenant partition: each personal/confidential partition is tenant-scoped by a
 * protected prefix, and detectTier reads its tier. The G1 comparison found
 * three unscoped partitions and five stores whose tier it misread; G2 closed them. A new entry
 * is a regression.
 */
const rootDir = process.cwd();
const readJson = <T>(rel: string): T =>
  JSON.parse(safeReadFile(path.join(rootDir, rel), { encoding: 'utf8' }) as string) as T;

const stores = readJson<{ stores: Array<AssetStoreDeclaration & { path: string }> }>(
  'knowledge/product/governance/store-catalog.json'
).stores;
const protectedPrefixes = readJson<{ tenant_scope: { protected_prefixes: string[] } }>(
  'knowledge/product/governance/security-policy.json'
).tenant_scope.protected_prefixes;

const partitioned = stores.filter(
  (store) =>
    store.status === 'active' &&
    store.custody.kind === 'tenant' &&
    store.path.includes('<tier>/<tenant>')
);
const PROTECTED_TIERS = ['personal', 'confidential'] as const;

describe('tenant store guard coverage', () => {
  it('tenant-scopes every personal and confidential tenant partition', () => {
    const missing = partitioned.flatMap((store) =>
      PROTECTED_TIERS.map((tier) => `${store.path.slice(0, store.path.indexOf('<tier>'))}${tier}/`)
    );
    expect(missing.filter((prefix) => !protectedPrefixes.includes(prefix)).sort()).toEqual([]);
  });

  it('reads the tier of every tenant partition from its path', () => {
    const misread = partitioned.flatMap((store) =>
      PROTECTED_TIERS.flatMap((tier) => {
        const sample = `${store.path.replace('<tier>', tier).replace('<tenant>', 'acme')}/x.json`;
        const resolution = resolveAssetAddress(sample, stores);
        const guardTier = detectTier(path.join(rootDir, sample));
        return resolution.status === 'resolved' && resolution.address.tier !== guardTier
          ? [`${store.id}:${tier}`]
          : [];
      })
    );
    expect(misread.sort()).toEqual([]);
  });
});
