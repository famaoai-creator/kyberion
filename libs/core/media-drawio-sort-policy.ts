import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

interface MediaDrawioSortPolicyCatalog {
  version: string;
  group_order: string[];
  type_order: string[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-drawio-sort-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-drawio-sort-policy.schema.json');

const catalog = defineCatalog<MediaDrawioSortPolicyCatalog>({
  id: 'media-drawio-sort-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMediaDrawioSortPolicyCatalog(): MediaDrawioSortPolicyCatalog {
  return catalog.load();
}

export function resolveMediaDrawioGroupRank(group?: string): number {
  const normalized = String(group || '')
    .trim()
    .toLowerCase();
  const catalog = loadMediaDrawioSortPolicyCatalog();
  const index = catalog.group_order.indexOf(normalized);
  return index >= 0 ? index : catalog.group_order.length;
}

export function resolveMediaDrawioTypeRank(type?: string): number {
  const normalized = String(type || '').trim();
  const catalog = loadMediaDrawioSortPolicyCatalog();
  const index = catalog.type_order.indexOf(normalized);
  return index >= 0 ? index : catalog.type_order.length;
}
