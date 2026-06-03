import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface ProviderCliCapabilityReportPolicyCatalog {
  version: string;
  title: string;
  summary_title: string;
  capability_inventory_title: string;
  provider_title_prefix: string;
  missing_adapter_title: string;
  missing_adapter_message: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/provider-cli-capability-report-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/provider-cli-capability-report-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: ProviderCliCapabilityReportPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: ProviderCliCapabilityReportPolicyCatalog = {
  version: '1.0.0',
  title: 'Provider CLI Capability Report',
  summary_title: 'Summary',
  capability_inventory_title: 'Capability Inventory',
  provider_title_prefix: 'By Provider',
  missing_adapter_title: 'Missing Adapter Coverage',
  missing_adapter_message: 'The following capabilities are registered but do not yet have a matching adapter profile:',
};

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateCatalog(value: unknown, label: string): ProviderCliCapabilityReportPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid provider CLI capability report policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as ProviderCliCapabilityReportPolicyCatalog;
}

export function loadProviderCliCapabilityReportPolicyCatalog(): ProviderCliCapabilityReportPolicyCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = FALLBACK_CATALOG;
    cachedCatalogPath = CATALOG_PATH;
    return cachedCatalog;
  }
  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  return parsed;
}

export function resolveProviderCliCapabilityReportPolicy(): ProviderCliCapabilityReportPolicyCatalog {
  return loadProviderCliCapabilityReportPolicyCatalog();
}

export function resetProviderCliCapabilityReportPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
