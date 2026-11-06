/**
 * G1 shadow run: next to every tier-guard tenant-scope decision, derive the
 * asset address from the store catalog (foundation/asset-address.ts) and
 * compare it with the guard's own classification (tier, tenant segment).
 *
 * Differences fall into the classes below, each with the reason it is
 * accepted for now; anything else is an unexplained disagreement, which fails
 * the call under Vitest so it surfaces in the permission tests. The run only
 * observes: it never changes a decision outside tests.
 */
import * as path from 'node:path';
import {
  addressTenant,
  compileStoreCatalog,
  resolveAssetAddress,
  type AssetAddress,
  type AssetTier,
  type CatalogStore,
} from './foundation/asset-address.js';
import { isVitestProcess } from './foundation/env.js';
import { rawExistsSync, rawReadTextFile } from './fs-primitives.js';
import { detectTier } from './tier-detect.js';

/** Known, accepted differences between the catalog address and the guard. */
export const KNOWN_ADDRESS_DIFFERENCES = {
  /** Tier is the disclosure ceiling and custody a separate axis: the guard scopes only personal/confidential tenant data. */
  'public-tier-tenant': 'tenant custody on the public tier, which the guard does not tenant-scope',
  /** The retired customer/ tree is only a migration source. */
  'legacy-customer': 'legacy customer/ store, read only by migrations 0001-0003',
  /** detectTier knows state roots and floors, not ledger roots or mission trees; their protected prefixes still scope them. */
  'guard-tier-unaware': 'detectTier reports a tier-partitioned store it does not know as public',
  /** A tenant-partitioned store the guard does not register (no protected prefix): G2 must register it. */
  'unregistered-tenant-partition': 'catalog tenant partition without a guard protected prefix',
} as const;

export type AddressDifference = keyof typeof KNOWN_ADDRESS_DIFFERENCES;

export interface AddressComparison {
  address: AssetAddress;
  /** Null when the catalog and the guard agree. */
  difference: AddressDifference | 'unexplained' | null;
  detail?: string;
}

/** Compare one path's catalog address with the guard's classification. */
export function compareAssetAddress(
  relativePath: string,
  address: AssetAddress,
  guard: { tier: AssetTier; tenant: string | null }
): AddressComparison {
  const tenant = addressTenant(address);
  const tierAgrees = address.tier === guard.tier;
  const tenantAgrees = tenant === guard.tenant;
  if (tierAgrees && tenantAgrees) return { address, difference: null };
  const detail = `tier ${address.tier}/${guard.tier}, tenant ${tenant ?? '-'}/${guard.tenant ?? '-'}`;
  if (address.store?.startsWith('legacy.'))
    return { address, difference: 'legacy-customer', detail };
  if (tierAgrees && address.tier === 'public' && tenant && guard.tenant === null)
    return { address, difference: 'public-tier-tenant', detail };
  if (tenantAgrees && guard.tier === 'public' && address.tier !== 'public')
    return { address, difference: 'guard-tier-unaware', detail };
  if (tenant && guard.tenant === null && address.tier !== 'public')
    return { address, difference: 'unregistered-tenant-partition', detail };
  return { address, difference: 'unexplained', detail };
}

const compiledByRoot = new Map<string, ReturnType<typeof compileStoreCatalog> | null>();

/** The compiled catalog of one repository root (tests repoint the root to fixtures). */
function catalogFor(rootDir: string): ReturnType<typeof compileStoreCatalog> | null {
  const cached = compiledByRoot.get(rootDir);
  if (cached !== undefined) return cached;
  const file = path.join(rootDir, 'knowledge', 'product', 'governance', 'store-catalog.json');
  let compiled: ReturnType<typeof compileStoreCatalog> | null = null;
  try {
    const parsed = rawExistsSync(file)
      ? (JSON.parse(rawReadTextFile(file)) as { stores?: CatalogStore[] })
      : null;
    compiled = parsed?.stores ? compileStoreCatalog(parsed.stores) : null;
  } catch {
    // An unreadable catalog only disables the observation, never a decision.
    compiled = null;
  }
  compiledByRoot.set(rootDir, compiled);
  return compiled;
}

const COMPARED_LIMIT = 10_000;
const compared = new Map<string, AddressComparison>();

/** Counts of each difference class seen in this process (for reports and tests). */
export const shadowCounts = new Map<AddressDifference | 'unexplained', number>();

/**
 * Run the shadow comparison for one guarded path. Under Vitest an unexplained
 * disagreement throws `[ASSET_ADDRESS_SHADOW]`; elsewhere it is only counted.
 */
export function shadowAssetAddress(
  rootDir: string,
  relativePath: string,
  guardTenant: string | null
): void {
  // The guard sees the same paths over and over; compare each one once.
  const key = `${rootDir}\0${relativePath}\0${guardTenant ?? ''}`;
  let result = compared.get(key);
  if (result === undefined) {
    const catalog = catalogFor(rootDir);
    if (!catalog) return;
    const guardTier = (p: string): AssetTier => detectTier(path.join(rootDir, p));
    result = compareAssetAddress(
      relativePath,
      resolveAssetAddress(relativePath, catalog, guardTier),
      {
        tier: guardTier(relativePath),
        tenant: guardTenant,
      }
    );
    if (compared.size >= COMPARED_LIMIT) compared.clear();
    compared.set(key, result);
  }
  const { difference, detail, address } = result;
  if (!difference) return;
  shadowCounts.set(difference, (shadowCounts.get(difference) ?? 0) + 1);
  if (difference === 'unexplained' && isVitestProcess())
    throw new Error(
      `[ASSET_ADDRESS_SHADOW] catalog address and tier-guard disagree for '${relativePath}' (${detail}, store ${address.store ?? '-'}) | next: fix the store catalog or record the difference class in tier-guard-asset-shadow.ts`
    );
}

/** Test seam: forget the cached catalog. */
export function resetAssetShadowCatalog(): void {
  compiledByRoot.clear();
  compared.clear();
  shadowCounts.clear();
}
