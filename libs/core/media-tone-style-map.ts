import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface MediaToneStyleMapEntry {
  tone: string;
  style:
    | 'base'
    | 'title'
    | 'subtitle'
    | 'header'
    | 'section'
    | 'info'
    | 'success'
    | 'warning'
    | 'danger'
    | 'body';
}

interface MediaToneStyleMapCatalog {
  version: string;
  tones: MediaToneStyleMapEntry[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-tone-style-map.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-tone-style-map.schema.json');

const FALLBACK_MAP: Record<string, MediaToneStyleMapEntry['style']> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
};

const catalog = defineCatalog<MediaToneStyleMapCatalog>({
  id: 'media-tone-style-map',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: () => ({
    version: '1.0.0',
    tones: Object.entries(FALLBACK_MAP).map(([tone, style]) => ({ tone, style })),
  }),
});

export function loadMediaToneStyleMapCatalog(): MediaToneStyleMapCatalog {
  return catalog.load();
}

export function resolveMediaToneStyle(tone?: string): MediaToneStyleMapEntry['style'] {
  const normalized = String(tone || '')
    .trim()
    .toLowerCase();
  if (!normalized) return 'info';
  const catalog = loadMediaToneStyleMapCatalog();
  const resolved = catalog.tones.find((entry) => entry.tone === normalized)?.style;
  return resolved || FALLBACK_MAP[normalized] || 'info';
}
