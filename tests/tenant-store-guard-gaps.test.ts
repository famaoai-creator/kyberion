import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';
import { resolveAssetAddress } from '@agent/core/foundation/asset-address';
import { detectTier } from '@agent/core/tier-guard';
import type { AssetStoreDeclaration } from '@agent/core/contracts/asset-scope';

/**
 * Where the store catalog (the asset address) and tier-guard still disagree.
 * Found by the G1 comparison; each list is the current, accepted state and is
 * meant to shrink to empty in G2. A new entry is a regression: a tenant store
 * the guard does not scope, or one whose tier the guard misreads.
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

describe('tenant store guard gaps (G1 → G2)', () => {
  it('lists the tenant partitions tier-guard does not tenant-scope', () => {
    const missing = partitioned.flatMap((store) =>
      PROTECTED_TIERS.map((tier) => `${store.path.slice(0, store.path.indexOf('<tier>'))}${tier}/`)
    );
    // Known gaps: tenant data on these personal/confidential partitions has no
    // protected prefix, so a caller bound to another tenant is not refused.
    expect(missing.filter((prefix) => !protectedPrefixes.includes(prefix)).sort()).toEqual([
      'active/projects/personal/',
      'active/shared/runtime/surface-management/confidential/',
      'active/shared/runtime/surface-management/personal/',
    ]);
  });

  it('lists the tenant partitions whose tier detectTier misreads as public', () => {
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
    // detectTier knows the state roots and floors, not the ledger roots: their
    // protected prefixes and store roles still scope them, but tier rules that
    // key on detectTier see public.
    expect(misread.sort()).toEqual([
      'runtime.execution-metrics.tenant:confidential',
      'runtime.execution-metrics.tenant:personal',
      'runtime.surface-management:confidential',
      'runtime.surface-management:personal',
      'runtime.tenant-approvals:confidential',
      'runtime.tenant-approvals:personal',
      'runtime.tenant-ledger:confidential',
      'runtime.tenant-ledger:personal',
      'runtime.usage-ledger.tenant:confidential',
      'runtime.usage-ledger.tenant:personal',
    ]);
  });
});
