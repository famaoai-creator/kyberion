import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

interface MediaDrawioTierOrderCatalog {
  version: string;
  tier_order: string[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-drawio-tier-order.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-drawio-tier-order.schema.json');

const catalog = defineCatalog<MediaDrawioTierOrderCatalog>({
  id: 'media-drawio-tier-order',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMediaDrawioTierOrderCatalog(): MediaDrawioTierOrderCatalog {
  return catalog.load();
}

export function resolveMediaDrawioTierRank(tier?: string): number {
  const normalized = String(tier || '')
    .trim()
    .toLowerCase();
  const catalog = loadMediaDrawioTierOrderCatalog();
  const index = catalog.tier_order.indexOf(normalized);
  return index >= 0 ? index : catalog.tier_order.length;
}
