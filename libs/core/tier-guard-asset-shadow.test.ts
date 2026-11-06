import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileStoreCatalog,
  resolveAssetAddress,
  type CatalogStore,
} from './foundation/asset-address.js';
import { compareAssetAddress } from './tier-guard-asset-shadow.js';
import { detectTier } from './tier-detect.js';
import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { isValidTenantSlug } from './foundation/scope.js';

const root = pathResolver.rootDir();
const stores = readJson<{ stores: CatalogStore[] }>(
  pathResolver.knowledge('product/governance/store-catalog.json')
).stores;
const prefixes = readJson<{ tenant_scope: { protected_prefixes: string[] } }>(
  pathResolver.knowledge('product/governance/security-policy.json')
).tenant_scope.protected_prefixes;
const catalog = compileStoreCatalog(stores);
const tierOf = (rel: string) => detectTier(path.join(root, rel));

/** The guard's tenant for a path: the segment after a protected prefix, when valid. */
function guardTenant(rel: string): string | null {
  const prefix = prefixes.find((candidate) => rel.startsWith(candidate));
  if (!prefix) return null;
  const tenant = rel.slice(prefix.length).split('/')[0];
  return isValidTenantSlug(tenant) ? tenant : null;
}

function samplePaths(): string[] {
  const paths = new Set<string>();
  for (const store of stores) {
    const tiers = store.path.includes('<tier>') ? ['personal', 'confidential', 'public'] : [''];
    for (const tier of tiers) {
      const sample = store.path
        .replace('<tier>', tier)
        .replace('<tenant>', 'acme')
        .replace('<slug>', 'me')
        .replace('<customer>', 'c1')
        .replace(/<[a-z_]+>/gu, 'x1');
      paths.add(sample);
      paths.add(`${sample}/child.json`);
    }
  }
  return [...paths].sort();
}

describe('asset address (G1 shadow)', () => {
  it('resolves the most specific store, its custody and tier', () => {
    expect(
      resolveAssetAddress('knowledge/confidential/acme/deals/DEAL-1.json', catalog, tierOf)
    ).toEqual({
      store: 'tenant-deals',
      custody: { kind: 'tenant', ref: 'acme' },
      tier: 'confidential',
    });
    expect(
      resolveAssetAddress('active/shared/runtime/dot/personal/acme/x.json', catalog, tierOf)
    ).toMatchObject({ store: 'dot', custody: { kind: 'tenant', ref: 'acme' }, tier: 'personal' });
    expect(
      resolveAssetAddress('knowledge/personal/stances/me/identity.json', catalog, tierOf)
    ).toMatchObject({ store: 'stance', custody: { kind: 'person', ref: 'installation-owner' } });
    // A path no store names has no store and keeps the guard tier.
    expect(resolveAssetAddress('README.md', catalog, tierOf)).toEqual({
      custody: { kind: 'unknown' },
      tier: 'public',
    });
  });

  it('every catalog store agrees with the guard or differs only in a known, recorded way', () => {
    const storesBy: Record<string, Set<string>> = {};
    for (const rel of samplePaths()) {
      const address = resolveAssetAddress(rel, catalog, tierOf);
      const { difference } = compareAssetAddress(rel, address, {
        tier: tierOf(rel),
        tenant: guardTenant(rel),
      });
      if (difference) (storesBy[difference] ??= new Set()).add(address.store ?? rel);
    }
    expect([...(storesBy.unexplained ?? [])]).toEqual([]);
    // Guard gaps the comparison found; G2 registers them as protected tenant partitions.
    expect([...(storesBy['unregistered-tenant-partition'] ?? [])].sort()).toEqual([
      'projects',
      'runtime.surface-management',
    ]);
  });
});
