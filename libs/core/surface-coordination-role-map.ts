import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { safeExistsSync } from './secure-io.js';
import type { GovernedArtifactRole } from './artifact-store.js';

interface SurfaceCoordinationRoleMap {
  version: string;
  entries: Array<{
    surface: string;
    role: GovernedArtifactRole;
    summary?: string;
  }>;
}

const PUBLIC_MAP_PATH = pathResolver.knowledge(
  'product/governance/surface-coordination-role-map.json'
);
const PERSONAL_MAP_PATH = pathResolver.knowledge(
  'personal/governance/surface-coordination-role-map.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/surface-coordination-role-map.schema.json'
);

let cachedMap: SurfaceCoordinationRoleMap | null = null;
let cachedMapKey: string | null = null;

const publicMapCatalog = defineCatalog<SurfaceCoordinationRoleMap>({
  id: 'surface-coordination-role-map',
  path: PUBLIC_MAP_PATH,
  schema: SCHEMA_PATH,
});
const personalMapCatalog = defineCatalog<SurfaceCoordinationRoleMap>({
  id: 'surface-coordination-role-map.personal',
  path: PERSONAL_MAP_PATH,
  schema: SCHEMA_PATH,
});

function loadMapFile(
  mapPath: string,
  catalog: typeof publicMapCatalog
): SurfaceCoordinationRoleMap | null {
  if (!safeExistsSync(mapPath)) return null;
  return catalog.load();
}

function mergeMaps(
  base: SurfaceCoordinationRoleMap,
  overlay: SurfaceCoordinationRoleMap
): SurfaceCoordinationRoleMap {
  const bySurface = new Map<
    string,
    { surface: string; role: GovernedArtifactRole; summary?: string }
  >();
  for (const entry of base.entries) bySurface.set(entry.surface, entry);
  for (const entry of overlay.entries) bySurface.set(entry.surface, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    entries: Array.from(bySurface.values()),
  };
}

export function getSurfaceCoordinationRole(surface: string): GovernedArtifactRole {
  const normalized = surface.trim();
  if (!normalized) return 'surface_runtime';
  const mapKey = `${PUBLIC_MAP_PATH}::${PERSONAL_MAP_PATH}`;
  if (!cachedMap || cachedMapKey !== mapKey) {
    const base = loadMapFile(PUBLIC_MAP_PATH, publicMapCatalog) ?? {
      version: '1.0.0',
      entries: [],
    };
    const personal = loadMapFile(PERSONAL_MAP_PATH, personalMapCatalog) ?? {
      version: base.version,
      entries: [],
    };
    cachedMap = mergeMaps(base, personal);
    cachedMapKey = mapKey;
  }
  return cachedMap.entries.find((entry) => entry.surface === normalized)?.role || 'surface_runtime';
}

export function resetSurfaceCoordinationRoleMapCache(): void {
  cachedMap = null;
  cachedMapKey = null;
}
