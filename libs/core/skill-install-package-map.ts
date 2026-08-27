import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { safeExistsSync } from './secure-io.js';

export interface SkillInstallPackageMapEntry {
  id: string;
  patterns: string[];
  install_type: 'brew' | 'pip';
  package_name: string;
  summary?: string;
}

interface SkillInstallPackageMap {
  version: string;
  entries: SkillInstallPackageMapEntry[];
}

const MAP_PATH = pathResolver.knowledge('product/governance/skill-install-package-map.json');
const PERSONAL_MAP_PATH = pathResolver.knowledge(
  'personal/governance/skill-install-package-map.json'
);
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/skill-install-package-map.schema.json');

let cachedMap: SkillInstallPackageMap | null = null;
let cachedKey: string | null = null;

const publicMapCatalog = defineCatalog<SkillInstallPackageMap>({
  id: 'skill-install-package-map',
  path: MAP_PATH,
  schema: SCHEMA_PATH,
});
const personalMapCatalog = defineCatalog<SkillInstallPackageMap>({
  id: 'skill-install-package-map.personal',
  path: PERSONAL_MAP_PATH,
  schema: SCHEMA_PATH,
});

function loadMapFile(
  mapPath: string,
  catalog: typeof publicMapCatalog
): SkillInstallPackageMap | null {
  if (!safeExistsSync(mapPath)) return null;
  return catalog.load();
}

function mergeMaps(
  base: SkillInstallPackageMap,
  overlay: SkillInstallPackageMap
): SkillInstallPackageMap {
  const byId = new Map<string, SkillInstallPackageMapEntry>();
  for (const entry of base.entries) byId.set(entry.id, entry);
  for (const entry of overlay.entries) byId.set(entry.id, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    entries: Array.from(byId.values()),
  };
}

export function loadSkillInstallPackageMap(): SkillInstallPackageMap {
  const key = `${MAP_PATH}::${PERSONAL_MAP_PATH}`;
  if (cachedMap && cachedKey === key) return cachedMap;

  const base = loadMapFile(MAP_PATH, publicMapCatalog) ?? { version: '1.0.0', entries: [] };
  const personal = loadMapFile(PERSONAL_MAP_PATH, personalMapCatalog) ?? {
    version: base.version,
    entries: [],
  };
  const merged = mergeMaps(base, personal);

  cachedMap = merged;
  cachedKey = key;
  return merged;
}

export function findSkillInstallPackageMapEntry(
  capabilityId: string
): SkillInstallPackageMapEntry | null {
  const normalized = capabilityId.trim().toLowerCase();
  if (!normalized) return null;
  return (
    loadSkillInstallPackageMap().entries.find((entry) =>
      entry.patterns.some((pattern) => normalized.includes(pattern.toLowerCase()))
    ) || null
  );
}

export function resetSkillInstallPackageMapCache(): void {
  cachedMap = null;
  cachedKey = null;
}
