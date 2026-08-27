import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

interface SpreadsheetStylePolicyCatalog {
  version: string;
  role_indices: Record<string, number>;
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/spreadsheet-style-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/spreadsheet-style-policy.schema.json');

const FALLBACK_CATALOG: SpreadsheetStylePolicyCatalog = {
  version: '1.0.0',
  role_indices: {
    base: 0,
    title: 1,
    subtitle: 2,
    header: 3,
    section: 4,
    info: 5,
    success: 6,
    warning: 7,
    danger: 8,
    body: 9,
  },
};

const catalog = defineCatalog<SpreadsheetStylePolicyCatalog>({
  id: 'spreadsheet-style-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadSpreadsheetStylePolicyCatalog(): SpreadsheetStylePolicyCatalog {
  return catalog.load();
}

export function resolveSpreadsheetStyleIndex(role: string): number {
  const normalized = String(role || '')
    .trim()
    .toLowerCase();
  const catalog = loadSpreadsheetStylePolicyCatalog();
  return catalog.role_indices[normalized] ?? FALLBACK_CATALOG.role_indices[normalized] ?? 0;
}

export function resetSpreadsheetStylePolicyCatalogCache(): void {
  catalog.reset();
}
