import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface ProviderCliCapabilityReportPolicyCatalog {
  version: string;
  title: string;
  summary_title: string;
  capability_inventory_title: string;
  provider_title_prefix: string;
  missing_adapter_title: string;
  missing_adapter_message: string;
}

const CATALOG_PATH = pathResolver.knowledge(
  'product/governance/provider-cli-capability-report-policy.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/provider-cli-capability-report-policy.schema.json'
);

const catalog = defineCatalog<ProviderCliCapabilityReportPolicyCatalog>({
  id: 'provider-cli-capability-report-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadProviderCliCapabilityReportPolicyCatalog(): ProviderCliCapabilityReportPolicyCatalog {
  return catalog.load();
}

export function resolveProviderCliCapabilityReportPolicy(): ProviderCliCapabilityReportPolicyCatalog {
  return loadProviderCliCapabilityReportPolicyCatalog();
}
