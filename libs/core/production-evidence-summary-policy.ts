import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface ProductionEvidenceSummaryPolicyCatalog {
  version: string;
  title_prefix: string;
  invalid_entries_title: string;
  pending_title: string;
  complete_message: string;
}

const CATALOG_PATH = pathResolver.knowledge(
  'product/governance/production-evidence-summary-policy.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/production-evidence-summary-policy.schema.json'
);

const FALLBACK_CATALOG: ProductionEvidenceSummaryPolicyCatalog = {
  version: '1.0.0',
  title_prefix: 'production evidence',
  invalid_entries_title: 'invalid register entries',
  pending_title: 'pending external evidence',
  complete_message: 'all production evidence is verified',
};

const catalog = defineCatalog<ProductionEvidenceSummaryPolicyCatalog>({
  id: 'production-evidence-summary-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadProductionEvidenceSummaryPolicyCatalog(): ProductionEvidenceSummaryPolicyCatalog {
  return catalog.load();
}

export function resolveProductionEvidenceSummaryPolicy(): ProductionEvidenceSummaryPolicyCatalog {
  return loadProductionEvidenceSummaryPolicyCatalog();
}

export function resetProductionEvidenceSummaryPolicyCatalogCache(): void {
  catalog.reset();
}
