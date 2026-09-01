import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { safeExistsSync } from './secure-io.js';

export interface ActuatorDependencyBundleEntry {
  id: string;
  actuator: string;
  dependency_ids: string[];
  summary?: string;
}

interface ActuatorDependencyBundles {
  version: string;
  bundles: ActuatorDependencyBundleEntry[];
}

const PUBLIC_PATH = pathResolver.knowledge('product/governance/actuator-dependency-bundles.json');
const PERSONAL_PATH = pathResolver.knowledge(
  'personal/governance/actuator-dependency-bundles.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/actuator-dependency-bundles.schema.json'
);

let cachedCatalog: ActuatorDependencyBundles | null = null;
let cachedKey: string | null = null;

const publicCatalog = defineCatalog<ActuatorDependencyBundles>({
  id: 'actuator-dependency-bundles',
  path: PUBLIC_PATH,
  schema: SCHEMA_PATH,
});
const personalCatalog = defineCatalog<ActuatorDependencyBundles>({
  id: 'actuator-dependency-bundles.personal',
  path: PERSONAL_PATH,
  schema: SCHEMA_PATH,
});

function loadCatalogFile(
  catalogPath: string,
  catalog: typeof publicCatalog
): ActuatorDependencyBundles | null {
  if (!safeExistsSync(catalogPath)) return null;
  return catalog.load();
}

function mergeCatalogs(
  base: ActuatorDependencyBundles,
  overlay: ActuatorDependencyBundles
): ActuatorDependencyBundles {
  const byId = new Map<string, ActuatorDependencyBundleEntry>();
  for (const entry of base.bundles) byId.set(entry.id, entry);
  for (const entry of overlay.bundles) byId.set(entry.id, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    bundles: Array.from(byId.values()),
  };
}

export function loadActuatorDependencyBundles(): ActuatorDependencyBundles {
  const cacheKey = `${PUBLIC_PATH}::${PERSONAL_PATH}`;
  if (cachedCatalog && cachedKey === cacheKey) return cachedCatalog;

  const base = loadCatalogFile(PUBLIC_PATH, publicCatalog) ?? { version: '1.0.0', bundles: [] };
  const personal = loadCatalogFile(PERSONAL_PATH, personalCatalog) ?? {
    version: base.version,
    bundles: [],
  };
  const merged = mergeCatalogs(base, personal);

  cachedCatalog = merged;
  cachedKey = cacheKey;
  return merged;
}

export function getActuatorDependencyBundle(
  actuator: string
): ActuatorDependencyBundleEntry | null {
  const normalized = actuator.trim();
  if (!normalized) return null;
  return (
    loadActuatorDependencyBundles().bundles.find((bundle) => bundle.actuator === normalized) || null
  );
}
