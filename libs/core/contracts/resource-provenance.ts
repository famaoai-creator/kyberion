/** PI-09: provenance and narrow-only resource overlays. */

export type ResourceProvenanceScope =
  'personal' | 'tenant' | 'organization' | 'project' | 'mission' | 'repository' | 'temporary';

export type ResourceOrigin = 'builtin' | 'plugin' | 'tenant-overlay' | 'generated';
export type ResourceTrust = 'trusted' | 'official' | 'approved' | 'third-party' | 'untrusted';

export interface ResourceProvenance {
  source: string;
  scope: ResourceProvenanceScope;
  origin: ResourceOrigin;
  base_dir: string;
  trust: ResourceTrust;
  plugin_id?: string;
}

export interface NarrowOnlyFilterResult {
  values: string[];
  removed: string[];
}

function normalizeName(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('[RESOURCE_FILTER_INVALID] empty resource selector');
  return normalized;
}

/**
 * Apply an overlay without allowing it to widen the manifest set.
 *
 * `-name` and `!name` remove an exact entry. `+name` is an explicit retain
 * marker: it is valid only for an entry already in the current set. Bare names
 * select an exact subset, but every selected name must already be in the base.
 */
export function applyNarrowOnlyFilter(
  baseValues: readonly string[],
  selectors: readonly string[]
): NarrowOnlyFilterResult {
  const base = Array.from(new Set(baseValues.map(normalizeName)));
  const baseSet = new Set(base);
  let selected = new Set(base);
  const removed = new Set<string>();
  const bare = selectors.filter((selector) => {
    const value = normalizeName(selector);
    return !value.startsWith('!') && !value.startsWith('+') && !value.startsWith('-');
  });

  if (bare.length > 0) {
    const requested = new Set(bare.map(normalizeName));
    for (const value of requested) {
      if (!baseSet.has(value)) {
        throw new Error(`[RESOURCE_FILTER_WIDENED] overlay selected undeclared resource: ${value}`);
      }
    }
    selected = new Set([...selected].filter((value) => requested.has(value)));
  }

  for (const rawSelector of selectors) {
    const selector = normalizeName(rawSelector);
    const prefix = selector[0];
    const name = prefix === '!' || prefix === '+' || prefix === '-' ? selector.slice(1) : selector;
    if (!name) throw new Error('[RESOURCE_FILTER_INVALID] selector name is required');
    if (!baseSet.has(name)) {
      throw new Error(`[RESOURCE_FILTER_WIDENED] overlay selected undeclared resource: ${name}`);
    }
    if (prefix === '+' && !selected.has(name)) {
      throw new Error(`[RESOURCE_FILTER_WIDENED] retain marker would widen resource set: ${name}`);
    }
    if (prefix === '!' || prefix === '-') {
      selected.delete(name);
      removed.add(name);
    }
  }

  return {
    values: base.filter((value) => selected.has(value)),
    removed: base.filter((value) => removed.has(value)),
  };
}
