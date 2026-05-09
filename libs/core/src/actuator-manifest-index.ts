import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat } from '../secure-io.js';

export interface ActuatorManifestFile {
  actuator_id: string;
  version: string;
  description?: string;
  contract_schema?: string;
  entrypoint?: string;
  capabilities?: Array<{ op?: string }>;
}

export interface ActuatorCatalogEntry {
  n: string;
  path: string;
  d: string;
  s: 'implemented';
  version: string;
  capability_count: number;
  contract_schema?: string;
  entrypoint?: string;
  manifest_path: string;
}

const DEFAULT_ACTUATORS_DIR = pathResolver.rootResolve('libs/actuators');
const catalogCache = new Map<string, ActuatorCatalogEntry[]>();

function readManifest(manifestPath: string): ActuatorManifestFile {
  return JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string) as ActuatorManifestFile;
}

export function loadActuatorManifestCatalog(actuatorsDir = DEFAULT_ACTUATORS_DIR): ActuatorCatalogEntry[] {
  const dir = pathResolver.rootResolve(actuatorsDir);
  const cached = catalogCache.get(dir);
  if (cached) {
    return cached;
  }

  if (!safeExistsSync(dir)) {
    catalogCache.set(dir, []);
    return [];
  }

  const catalog: ActuatorCatalogEntry[] = [];
  const relativeDir = path.relative(pathResolver.rootDir(), dir) || path.basename(dir);
  for (const entry of safeReaddir(dir).sort()) {
    const actuatorDir = path.join(dir, entry);
    if (!safeStat(actuatorDir).isDirectory()) {
      continue;
    }

    const manifestPath = path.join(actuatorDir, 'manifest.json');
    if (!safeExistsSync(manifestPath)) {
      continue;
    }

    const manifest = readManifest(manifestPath);
    if (!manifest.actuator_id) {
      continue;
    }

    catalog.push({
      n: manifest.actuator_id,
      path: path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry),
      d: manifest.description || 'No description available.',
      s: 'implemented',
      version: manifest.version || '0.0.0',
      capability_count: Array.isArray(manifest.capabilities) ? manifest.capabilities.length : 0,
      contract_schema: manifest.contract_schema,
      entrypoint: manifest.entrypoint,
      manifest_path: path.relative(pathResolver.rootDir(), manifestPath),
    });
  }

  catalogCache.set(dir, catalog);
  return catalog;
}

export function buildActuatorManifestIndexSnapshot(entries: ActuatorCatalogEntry[]) {
  return {
    v: '2.2.0',
    t: entries.length,
    u: new Date().toISOString(),
    actuators: entries.map(({ manifest_path: _manifestPath, ...entry }) => entry),
  };
}
