import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

interface SpreadsheetStylePolicyCatalog {
  version: string;
  role_indices: Record<string, number>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/spreadsheet-style-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/spreadsheet-style-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: SpreadsheetStylePolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

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

function validateCatalog(value: unknown, label: string): SpreadsheetStylePolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid spreadsheet style policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as SpreadsheetStylePolicyCatalog;
}

export function loadSpreadsheetStylePolicyCatalog(): SpreadsheetStylePolicyCatalog {
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

export function resolveSpreadsheetStyleIndex(role: string): number {
  const normalized = String(role || '').trim().toLowerCase();
  const catalog = loadSpreadsheetStylePolicyCatalog();
  return catalog.role_indices[normalized] ?? FALLBACK_CATALOG.role_indices[normalized] ?? 0;
}

export function resetSpreadsheetStylePolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
