import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

interface LegacyMediaOpsCatalog {
  version: string;
  ops: string[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/legacy-media-ops.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/legacy-media-ops.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: LegacyMediaOpsCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: LegacyMediaOpsCatalog = {
  version: '1.0.0',
  ops: [
    'document_report_design_from_brief',
    'document_spreadsheet_design_from_brief',
    'document_diagram_render_from_brief',
  ],
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

function validateCatalog(value: unknown, label: string): LegacyMediaOpsCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid legacy media ops catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as LegacyMediaOpsCatalog;
}

export function loadLegacyMediaOpsCatalog(): LegacyMediaOpsCatalog {
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

export function isLegacyMediaOp(op: string): boolean {
  const normalized = String(op || '').trim();
  if (!normalized) return false;
  return loadLegacyMediaOpsCatalog().ops.includes(normalized);
}

export function resetLegacyMediaOpsCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
