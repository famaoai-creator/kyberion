import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

interface SpreadsheetStylePolicyCatalog {
  version: string;
  role_indices: Record<string, number>;
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/spreadsheet-style-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/spreadsheet-style-policy.schema.json');

const catalog = defineCatalog<SpreadsheetStylePolicyCatalog>({
  id: 'spreadsheet-style-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadSpreadsheetStylePolicyCatalog(): SpreadsheetStylePolicyCatalog {
  return catalog.load();
}

export function resolveSpreadsheetStyleIndex(role: string): number {
  const normalized = String(role || '')
    .trim()
    .toLowerCase();
  const catalog = loadSpreadsheetStylePolicyCatalog();
  return catalog.role_indices[normalized] ?? 0;
}
