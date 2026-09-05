import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

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
