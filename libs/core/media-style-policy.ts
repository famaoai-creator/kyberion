import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { recordConfigFallback } from './config-fallback-registry.js';

export interface MediaBorderKeySideEntry {
  key_char: 'T' | 'B' | 'L' | 'R';
  side: 'top' | 'bottom' | 'left' | 'right';
}

interface MediaStylePolicyCatalog {
  version: string;
  signal_tone_ranks: Record<string, number>;
  border_key_sides: MediaBorderKeySideEntry[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-style-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-style-policy.schema.json');

const catalog = defineCatalog<MediaStylePolicyCatalog>({
  id: 'media-style-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: () => ({
    version: '1.0.0',
    // A missing policy must not silently recreate the governed catalog in code.
    // Keep only conservative behavior until the catalog is restored.
    signal_tone_ranks: {},
    border_key_sides: [],
  }),
  onFallback: (error, fallback) =>
    recordConfigFallback({ knowledgePath: CATALOG_PATH, error, defaults: fallback }),
});

export function loadMediaStylePolicyCatalog(): MediaStylePolicyCatalog {
  return catalog.load();
}

export function resolveSignalToneRank(tone?: string): number {
  const normalized = String(tone || '')
    .trim()
    .toLowerCase();
  if (!normalized) return 2;
  const catalog = loadMediaStylePolicyCatalog();
  return catalog.signal_tone_ranks[normalized] ?? 2;
}

export function resolveBorderKeySides(key: string): Array<'top' | 'bottom' | 'left' | 'right'> {
  const normalized = String(key || '')
    .trim()
    .toUpperCase();
  if (!normalized) return [];
  const catalog = loadMediaStylePolicyCatalog();
  const sides = new Set<'top' | 'bottom' | 'left' | 'right'>();
  for (const entry of catalog.border_key_sides) {
    if (normalized.includes(entry.key_char)) sides.add(entry.side);
  }
  return Array.from(sides);
}
