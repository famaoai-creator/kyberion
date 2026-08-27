import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getFoundationIo } from './foundation/io.js';

export interface ServiceAuthorityMapEntry {
  id: string;
  service_id: string;
  authorities: string[];
  summary?: string;
}

interface ServiceAuthorityMap {
  version: string;
  services: ServiceAuthorityMapEntry[];
}

const PUBLIC_MAP_PATH = pathResolver.knowledge('product/governance/service-authority-map.json');
const PERSONAL_MAP_PATH = pathResolver.knowledge('personal/governance/service-authority-map.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/service-authority-map.schema.json');

let cachedMap: ServiceAuthorityMap | null = null;
let cachedMapKey: string | null = null;

const publicMapCatalog = defineCatalog<ServiceAuthorityMap>({
  id: 'service-authority-map',
  path: PUBLIC_MAP_PATH,
  schema: SCHEMA_PATH,
});

const personalMapCatalog = defineCatalog<ServiceAuthorityMap>({
  id: 'service-authority-map.personal',
  path: PERSONAL_MAP_PATH,
  schema: SCHEMA_PATH,
});

function loadMapFile(
  mapPath: string,
  catalog: typeof publicMapCatalog
): ServiceAuthorityMap | null {
  if (!getFoundationIo().exists(mapPath)) return null;
  return catalog.load();
}

function mergeMaps(base: ServiceAuthorityMap, overlay: ServiceAuthorityMap): ServiceAuthorityMap {
  const byId = new Map<string, ServiceAuthorityMapEntry>();
  for (const entry of base.services) byId.set(entry.id, entry);
  for (const entry of overlay.services) byId.set(entry.id, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    services: Array.from(byId.values()),
  };
}

export function loadServiceAuthorityMap(): ServiceAuthorityMap {
  const cacheKey = `${PUBLIC_MAP_PATH}::${PERSONAL_MAP_PATH}`;
  if (cachedMap && cachedMapKey === cacheKey) return cachedMap;

  const base = loadMapFile(PUBLIC_MAP_PATH, publicMapCatalog) ?? {
    version: '1.0.0',
    services: [],
  };
  const personal = loadMapFile(PERSONAL_MAP_PATH, personalMapCatalog) ?? {
    version: base.version,
    services: [],
  };
  const merged = mergeMaps(base, personal);

  cachedMap = merged;
  cachedMapKey = cacheKey;
  return merged;
}

export function listServiceAuthorityMapEntries(): ServiceAuthorityMapEntry[] {
  return loadServiceAuthorityMap().services;
}

export function getServiceAuthorities(serviceId: string): string[] {
  const normalized = serviceId.trim();
  if (!normalized) return [];
  return (
    listServiceAuthorityMapEntries().find((entry) => entry.service_id === normalized)
      ?.authorities || []
  );
}

export function resetServiceAuthorityMapCache(): void {
  cachedMap = null;
  cachedMapKey = null;
}
