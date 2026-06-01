import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface ProductionEvidenceSummaryPolicyCatalog {
  version: string;
  title_prefix: string;
  invalid_entries_title: string;
  pending_title: string;
  complete_message: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/production-evidence-summary-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/production-evidence-summary-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: ProductionEvidenceSummaryPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: ProductionEvidenceSummaryPolicyCatalog = {
  version: '1.0.0',
  title_prefix: 'production evidence',
  invalid_entries_title: 'invalid register entries',
  pending_title: 'pending external evidence',
  complete_message: 'all production evidence is verified',
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

function validateCatalog(value: unknown, label: string): ProductionEvidenceSummaryPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid production evidence summary policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as ProductionEvidenceSummaryPolicyCatalog;
}

export function loadProductionEvidenceSummaryPolicyCatalog(): ProductionEvidenceSummaryPolicyCatalog {
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

export function resolveProductionEvidenceSummaryPolicy(): ProductionEvidenceSummaryPolicyCatalog {
  return loadProductionEvidenceSummaryPolicyCatalog();
}

export function resetProductionEvidenceSummaryPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
