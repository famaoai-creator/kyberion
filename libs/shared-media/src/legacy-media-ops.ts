import { pathResolver } from '@agent/core/path-resolver';
import { defineCatalog } from '@agent/core/foundation/governed-catalog';

interface LegacyMediaOpsCatalog {
  version: string;
  ops: string[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/legacy-media-ops.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/legacy-media-ops.schema.json');

const catalog = defineCatalog<LegacyMediaOpsCatalog>({
  id: 'legacy-media-ops',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadLegacyMediaOpsCatalog(): LegacyMediaOpsCatalog {
  return catalog.load();
}

export function isLegacyMediaOp(op: string): boolean {
  const normalized = String(op || '').trim();
  if (!normalized) return false;
  return loadLegacyMediaOpsCatalog().ops.includes(normalized);
}
