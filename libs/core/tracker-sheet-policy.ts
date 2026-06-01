import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface TrackerSheetPolicyCatalog {
  version: string;
  sheet_titles: {
    overview: string;
    execution_board: string;
    signals: string;
  };
  summary_empty_message: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('public/governance/tracker-sheet-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/tracker-sheet-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: TrackerSheetPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_CATALOG: TrackerSheetPolicyCatalog = {
  version: '1.0.0',
  sheet_titles: {
    overview: 'Overview',
    execution_board: 'Execution Board',
    signals: 'Signals and Risks',
  },
  summary_empty_message: 'No summary cards provided.',
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

function validateCatalog(value: unknown, label: string): TrackerSheetPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid tracker sheet policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as TrackerSheetPolicyCatalog;
}

export function loadTrackerSheetPolicyCatalog(): TrackerSheetPolicyCatalog {
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

export function resetTrackerSheetPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
