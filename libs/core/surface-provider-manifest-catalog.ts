import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat } from './secure-io.js';
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
const CATALOG_DIR = pathResolver.knowledge('public/governance/surface-provider-manifest-catalogs');
const CATALOG_SCHEMA_PATH = pathResolver.knowledge('public/schemas/surface-provider-manifest-catalog.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: SurfaceProviderManifestCatalog | null = null;
let cachedCatalogPath: string | null = null;
let cachedCatalogDirMtime: number | null = null;
let cachedCatalogSnapshotMtime: number | null = null;

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

function readMtime(filePath: string): number {
  try {
    return safeStat(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function loadCatalogDirectory(): SurfaceProviderManifestCatalog | null {
  if (!safeExistsSync(CATALOG_DIR)) return null;
  const files = safeReaddir(CATALOG_DIR).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) return null;

  const entries: SurfaceProviderManifestCatalogEntry[] = [];
  for (const file of files) {
    const value = validateCatalog(
      JSON.parse(safeReadFile(pathResolver.knowledge(`public/governance/surface-provider-manifest-catalogs/${file}`), { encoding: 'utf8' }) as string),
      `${CATALOG_DIR}/${file}`,
    );
    if ((value.entries || []).length !== 1) {
      throw new Error(`Invalid surface provider catalog file ${file}: expected exactly one entry`);
    }
    const entry = value.entries[0];
    if (entry.id !== file.replace(/\.json$/i, '')) {
      throw new Error(`Invalid surface provider catalog file ${file}: file name must match entry id (${entry.id})`);
    }
    entries.push(entry);
  }

  return { version: '1.0.0', entries };
}

export function loadSurfaceProviderManifestCatalog(): SurfaceProviderManifestCatalog | null {
  const dirMtime = readMtime(CATALOG_DIR);
  const snapshotMtime = readMtime(CATALOG_PATH);
  if (
    cachedCatalog &&
    cachedCatalogPath === CATALOG_PATH &&
    cachedCatalogDirMtime === dirMtime &&
    cachedCatalogSnapshotMtime === snapshotMtime
  ) return cachedCatalog;

  const directoryCatalog = loadCatalogDirectory();
  if (directoryCatalog) {
    cachedCatalog = directoryCatalog;
    cachedCatalogPath = CATALOG_PATH;
    cachedCatalogDirMtime = dirMtime;
    cachedCatalogSnapshotMtime = snapshotMtime;
    return cachedCatalog;
  }

  if (!safeExistsSync(CATALOG_PATH)) return null;

  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  cachedCatalogDirMtime = dirMtime;
  cachedCatalogSnapshotMtime = snapshotMtime;
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
  cachedCatalogDirMtime = null;
  cachedCatalogSnapshotMtime = null;
}
