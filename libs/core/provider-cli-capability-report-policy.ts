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

const FALLBACK_CATALOG: ProviderCliCapabilityReportPolicyCatalog = {
  version: '1.0.0',
  title: 'Provider CLI Capability Report',
  summary_title: 'Summary',
  capability_inventory_title: 'Capability Inventory',
  provider_title_prefix: 'By Provider',
  missing_adapter_title: 'Missing Adapter Coverage',
  missing_adapter_message:
    'The following capabilities are registered but do not yet have a matching adapter profile:',
};

const catalog = defineCatalog<ProviderCliCapabilityReportPolicyCatalog>({
  id: 'provider-cli-capability-report-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadProviderCliCapabilityReportPolicyCatalog(): ProviderCliCapabilityReportPolicyCatalog {
  return catalog.load();
}

export function resolveProviderCliCapabilityReportPolicy(): ProviderCliCapabilityReportPolicyCatalog {
  return loadProviderCliCapabilityReportPolicyCatalog();
}

export function resetProviderCliCapabilityReportPolicyCatalogCache(): void {
  catalog.reset();
}
