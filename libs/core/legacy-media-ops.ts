import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

interface LegacyMediaOpsCatalog {
  version: string;
  ops: string[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/legacy-media-ops.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/legacy-media-ops.schema.json');

const FALLBACK_CATALOG: LegacyMediaOpsCatalog = {
  version: '1.0.0',
  ops: [
    'document_report_design_from_brief',
    'document_spreadsheet_design_from_brief',
    'document_diagram_render_from_brief',
  ],
};

const catalog = defineCatalog<LegacyMediaOpsCatalog>({
  id: 'legacy-media-ops',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadLegacyMediaOpsCatalog(): LegacyMediaOpsCatalog {
  return catalog.load();
}

export function isLegacyMediaOp(op: string): boolean {
  const normalized = String(op || '').trim();
  if (!normalized) return false;
  return loadLegacyMediaOpsCatalog().ops.includes(normalized);
}

export function resetLegacyMediaOpsCatalogCache(): void {
  catalog.reset();
}
