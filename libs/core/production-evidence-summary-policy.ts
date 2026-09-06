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

const catalog = defineCatalog<ProductionEvidenceSummaryPolicyCatalog>({
  id: 'production-evidence-summary-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadProductionEvidenceSummaryPolicyCatalog(): ProductionEvidenceSummaryPolicyCatalog {
  return catalog.load();
}

export function resolveProductionEvidenceSummaryPolicy(): ProductionEvidenceSummaryPolicyCatalog {
  return loadProductionEvidenceSummaryPolicyCatalog();
}
