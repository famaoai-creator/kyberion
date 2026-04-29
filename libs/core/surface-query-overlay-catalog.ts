import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface SurfaceQueryOverlayCatalogEntry {
  id: string;
  kind: 'role' | 'phase' | 'personal';
  role?: string;
  phase?: string;
  path: string;
  summary?: string;
  status?: string;
}

export interface SurfaceQueryOverlayCatalog {
  version: string;
  base_config_path: string;
  personal_overlay_path?: string;
  overlays: SurfaceQueryOverlayCatalogEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const CATALOG_PATH = pathResolver.knowledge('public/governance/surface-query-overlay-catalog.json');
const CATALOG_SCHEMA_PATH = pathResolver.knowledge('public/schemas/surface-query-overlay-catalog.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: SurfaceQueryOverlayCatalog | null = null;
let cachedCatalogPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, CATALOG_SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
}

function validateCatalog(value: unknown, label: string): SurfaceQueryOverlayCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid surface query overlay catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as SurfaceQueryOverlayCatalog;
}

export function loadSurfaceQueryOverlayCatalog(): SurfaceQueryOverlayCatalog | null {
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

export function listSurfaceQueryOverlayCatalogEntries(): SurfaceQueryOverlayCatalogEntry[] {
  return loadSurfaceQueryOverlayCatalog()?.overlays || [];
}

export function getSurfaceQueryOverlayCatalogEntry(id: string): SurfaceQueryOverlayCatalogEntry | null {
  const normalized = id.trim();
  if (!normalized) return null;
  return listSurfaceQueryOverlayCatalogEntries().find((entry) => entry.id === normalized) || null;
}

export function resetSurfaceQueryOverlayCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
