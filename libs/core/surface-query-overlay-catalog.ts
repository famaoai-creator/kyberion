import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { safeExistsSync } from './secure-io.js';

export interface SurfaceQueryOverlayCatalogEntry {
  id: string;
  kind: 'role' | 'phase' | 'tenant' | 'personal';
  role?: string;
  phase?: string;
  tenant?: string;
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

const CATALOG_PATH = pathResolver.knowledge(
  'product/governance/surface-query-overlay-catalog.json'
);
const CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/surface-query-overlay-catalog.schema.json'
);

const catalog = defineCatalog<SurfaceQueryOverlayCatalog>({
  id: 'surface-query-overlay-catalog',
  path: CATALOG_PATH,
  schema: CATALOG_SCHEMA_PATH,
});

export function loadSurfaceQueryOverlayCatalog(): SurfaceQueryOverlayCatalog | null {
  if (!safeExistsSync(CATALOG_PATH)) return null;
  return catalog.load();
}

export function listSurfaceQueryOverlayCatalogEntries(): SurfaceQueryOverlayCatalogEntry[] {
  return loadSurfaceQueryOverlayCatalog()?.overlays || [];
}

export function getSurfaceQueryOverlayCatalogEntry(
  id: string
): SurfaceQueryOverlayCatalogEntry | null {
  const normalized = id.trim();
  if (!normalized) return null;
  return listSurfaceQueryOverlayCatalogEntries().find((entry) => entry.id === normalized) || null;
}
