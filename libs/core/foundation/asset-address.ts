import { isValidTenantSlug } from './scope.js';

/**
 * G1 of the store-catalog guard design: the address of an asset — which store
 * it is in, who holds custody of it, and its tier — derived from the store
 * catalog (`knowledge/product/governance/store-catalog.json`) alone. A pure
 * function: no I/O, no identity. Paths the catalog does not name get no store
 * and fall back to the caller's tier rule.
 */

export type AssetTier = 'personal' | 'confidential' | 'public';

export type CustodyKind = 'system' | 'tenant' | 'person' | 'derived' | 'unscoped-legacy';

export interface CatalogStore {
  id: string;
  path: string;
  custody: { kind: CustodyKind; ref?: string };
  tiers?: string[];
}

export interface AssetAddress {
  /** Catalog id of the most specific store containing the path, if any. */
  store?: string;
  custody: { kind: CustodyKind | 'unknown'; ref?: string };
  tier: AssetTier;
}

interface CompiledStore {
  store: CatalogStore;
  segments: string[];
  literals: number;
}

const TIERS: ReadonlySet<string> = new Set(['personal', 'confidential', 'public']);
const SLUG = /^[a-z][a-z0-9-]{0,60}$/u;
const ANY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Which concrete segment a template placeholder accepts. */
function placeholderAccepts(placeholder: string, segment: string): boolean {
  switch (placeholder) {
    case '<tier>':
      return TIERS.has(segment);
    case '<tenant>':
      return isValidTenantSlug(segment);
    case '<slug>':
    case '<customer>':
      return SLUG.test(segment);
    default:
      return ANY_SEGMENT.test(segment);
  }
}

const isPlaceholder = (segment: string): boolean => /^<[a-z_]+>$/u.test(segment);

export function compileStoreCatalog(stores: readonly CatalogStore[]): CompiledStore[] {
  return stores
    .map((store) => {
      const segments = store.path.split('/').filter(Boolean);
      return { store, segments, literals: segments.filter((s) => !isPlaceholder(s)).length };
    })
    .sort((a, b) => b.segments.length - a.segments.length || b.literals - a.literals);
}

function bind(compiled: CompiledStore, parts: string[]): Map<string, string> | null {
  if (parts.length < compiled.segments.length) return null;
  const bindings = new Map<string, string>();
  for (let i = 0; i < compiled.segments.length; i += 1) {
    const template = compiled.segments[i];
    const part = parts[i];
    if (isPlaceholder(template)) {
      if (!placeholderAccepts(template, part)) return null;
      bindings.set(template, part);
    } else if (template !== part) {
      return null;
    }
  }
  return bindings;
}

/**
 * The address of a repo-relative path. `fallbackTier` decides the tier when
 * the store does not (no `<tier>` segment and not exactly one declared tier).
 */
export function resolveAssetAddress(
  relativePath: string,
  catalog: readonly CompiledStore[],
  fallbackTier: (relativePath: string) => AssetTier
): AssetAddress {
  const parts = relativePath.split(/[\\/]/u).filter(Boolean);
  for (const compiled of catalog) {
    const bindings = bind(compiled, parts);
    if (!bindings) continue;
    const { store } = compiled;
    const ref = store.custody.ref;
    const boundRef = ref && isPlaceholder(ref) ? bindings.get(ref) : ref;
    const declaredTier = store.tiers?.length === 1 ? store.tiers[0] : undefined;
    const tier = (bindings.get('<tier>') ??
      declaredTier ??
      fallbackTier(relativePath)) as AssetTier;
    return {
      store: store.id,
      custody: { kind: store.custody.kind, ...(boundRef ? { ref: boundRef } : {}) },
      tier,
    };
  }
  return { custody: { kind: 'unknown' }, tier: fallbackTier(relativePath) };
}

/** The tenant an address is held by, or null. */
export function addressTenant(address: AssetAddress): string | null {
  return address.custody.kind === 'tenant' && address.custody.ref ? address.custody.ref : null;
}
