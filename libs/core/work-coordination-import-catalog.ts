import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface WorkCoordinationImportCatalogEntry {
  id: string;
  command: string;
  source: 'github' | 'jira';
  default_project_id?: string | null;
  summary?: string;
  notes?: string;
}

interface WorkCoordinationImportCatalog {
  version: string;
  imports: WorkCoordinationImportCatalogEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const PUBLIC_CATALOG_PATH = pathResolver.knowledge('product/governance/work-coordination-import-catalog.json');
const PERSONAL_CATALOG_PATH = pathResolver.knowledge('personal/governance/work-coordination-import-catalog.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/work-coordination-import-catalog.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: WorkCoordinationImportCatalog | null = null;
let cachedCatalogKey: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
}

function validateCatalog(value: unknown, label: string): WorkCoordinationImportCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid work coordination import catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as WorkCoordinationImportCatalog;
}

function loadCatalogFile(catalogPath: string): WorkCoordinationImportCatalog | null {
  if (!safeExistsSync(catalogPath)) return null;
  return validateCatalog(JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string), catalogPath);
}

function mergeCatalogs(base: WorkCoordinationImportCatalog, overlay: WorkCoordinationImportCatalog): WorkCoordinationImportCatalog {
  const byId = new Map<string, WorkCoordinationImportCatalogEntry>();
  for (const entry of base.imports) byId.set(entry.id, entry);
  for (const entry of overlay.imports) byId.set(entry.id, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    imports: Array.from(byId.values()),
  };
}

export function loadWorkCoordinationImportCatalog(): WorkCoordinationImportCatalog {
  const cacheKey = `${PUBLIC_CATALOG_PATH}::${PERSONAL_CATALOG_PATH}`;
  if (cachedCatalog && cachedCatalogKey === cacheKey) return cachedCatalog;

  const base = loadCatalogFile(PUBLIC_CATALOG_PATH) ?? { version: '1.0.0', imports: [] };
  const personal = loadCatalogFile(PERSONAL_CATALOG_PATH) ?? { version: base.version, imports: [] };
  const merged = mergeCatalogs(base, personal);

  cachedCatalog = merged;
  cachedCatalogKey = cacheKey;
  return merged;
}

export function listWorkCoordinationImportCatalogEntries(): WorkCoordinationImportCatalogEntry[] {
  return loadWorkCoordinationImportCatalog().imports;
}

export function getWorkCoordinationImportCatalogEntryByCommand(command: string): WorkCoordinationImportCatalogEntry | null {
  const normalized = command.trim();
  if (!normalized) return null;
  return listWorkCoordinationImportCatalogEntries().find((entry) => entry.command === normalized) || null;
}

export function resetWorkCoordinationImportCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogKey = null;
}
