import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir, safeStat } from './secure-io.js';
import { defineCatalog } from './foundation/governed-catalog.js';

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

const CATALOG_PATH = pathResolver.knowledge(
  'product/governance/surface-provider-manifest-catalog.json'
);
const CATALOG_DIR = pathResolver.knowledge('product/governance/surface-provider-manifest-catalogs');
const CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/surface-provider-manifest-catalog.schema.json'
);

let cachedCatalog: SurfaceProviderManifestCatalog | null = null;
let cachedCatalogPath: string | null = null;
let cachedCatalogDirMtime: number | null = null;
let cachedCatalogSnapshotMtime: number | null = null;

const surfaceProviderManifestCatalog = defineCatalog<SurfaceProviderManifestCatalog>({
  id: 'surface-provider-manifest-catalog',
  path: CATALOG_PATH,
  schema: CATALOG_SCHEMA_PATH,
});

function readMtime(filePath: string): number {
  try {
    return safeStat(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function loadCatalogDirectory(): SurfaceProviderManifestCatalog | null {
  if (!safeExistsSync(CATALOG_DIR)) return null;
  const files = safeReaddir(CATALOG_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) return null;

  const entries: SurfaceProviderManifestCatalogEntry[] = [];
  for (const file of files) {
    const value = defineCatalog<SurfaceProviderManifestCatalog>({
      id: `surface-provider-manifest-catalog.${file}`,
      path: pathResolver.knowledge(`product/governance/surface-provider-manifest-catalogs/${file}`),
      schema: CATALOG_SCHEMA_PATH,
    }).load();
    if ((value.entries || []).length !== 1) {
      throw new Error(`Invalid surface provider catalog file ${file}: expected exactly one entry`);
    }
    const entry = value.entries[0];
    if (entry.id !== file.replace(/\.json$/i, '')) {
      throw new Error(
        `Invalid surface provider catalog file ${file}: file name must match entry id (${entry.id})`
      );
    }
    entries.push(entry);
  }

  return { version: '1.0.0', entries };
}

export function loadSurfaceProviderManifestCatalogDirectory(): SurfaceProviderManifestCatalog {
  const catalog = loadCatalogDirectory();
  if (!catalog) {
    throw new Error(`Surface provider manifest catalog directory is empty: ${CATALOG_DIR}`);
  }
  return catalog;
}

export function loadSurfaceProviderManifestCatalog(): SurfaceProviderManifestCatalog | null {
  const dirMtime = readMtime(CATALOG_DIR);
  const snapshotMtime = readMtime(CATALOG_PATH);
  if (
    cachedCatalog &&
    cachedCatalogPath === CATALOG_PATH &&
    cachedCatalogDirMtime === dirMtime &&
    cachedCatalogSnapshotMtime === snapshotMtime
  )
    return cachedCatalog;

  const directoryCatalog = loadCatalogDirectory();
  if (directoryCatalog) {
    cachedCatalog = directoryCatalog;
    cachedCatalogPath = CATALOG_PATH;
    cachedCatalogDirMtime = dirMtime;
    cachedCatalogSnapshotMtime = snapshotMtime;
    return cachedCatalog;
  }

  if (!safeExistsSync(CATALOG_PATH)) return null;

  const parsed = surfaceProviderManifestCatalog.load();
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  cachedCatalogDirMtime = dirMtime;
  cachedCatalogSnapshotMtime = snapshotMtime;
  return cachedCatalog;
}

export function listSurfaceProviderManifestCatalogEntries(): SurfaceProviderManifestCatalogEntry[] {
  return loadSurfaceProviderManifestCatalog()?.entries || [];
}

export function getSurfaceProviderManifestCatalogEntry(
  id: string
): SurfaceProviderManifestCatalogEntry | null {
  const normalized = id.trim();
  if (!normalized) return null;
  return (
    listSurfaceProviderManifestCatalogEntries().find((entry) => entry.id === normalized) || null
  );
}
