import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface SurfaceProviderManifestCatalogEntry {
  id: string;
  channel: string;
  manifest_path: string;
  policy_path?: string;
  status: string;
  summary?: string;
}

export interface SurfaceProviderManifestCatalog {
  version: string;
  entries: SurfaceProviderManifestCatalogEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const CATALOG_PATH = pathResolver.knowledge('public/governance/surface-provider-manifest-catalog.json');
const CATALOG_SCHEMA_PATH = pathResolver.knowledge('public/schemas/surface-provider-manifest-catalog.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: SurfaceProviderManifestCatalog | null = null;
let cachedCatalogPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, CATALOG_SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
}

function validateCatalog(value: unknown, label: string): SurfaceProviderManifestCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid surface provider manifest catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as SurfaceProviderManifestCatalog;
}

export function loadSurfaceProviderManifestCatalog(): SurfaceProviderManifestCatalog | null {
  if (!safeExistsSync(CATALOG_PATH)) return null;
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;

  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  return cachedCatalog;
}

export function listSurfaceProviderManifestCatalogEntries(): SurfaceProviderManifestCatalogEntry[] {
  return loadSurfaceProviderManifestCatalog()?.entries || [];
}

export function getSurfaceProviderManifestCatalogEntry(id: string): SurfaceProviderManifestCatalogEntry | null {
  const normalized = id.trim();
  if (!normalized) return null;
  return listSurfaceProviderManifestCatalogEntries().find((entry) => entry.id === normalized) || null;
}

export function resetSurfaceProviderManifestCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
