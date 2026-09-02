import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { nowIso } from '../foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir, safeStat } from '../secure-io.js';

export interface ActuatorManifestFile {
  actuator_id: string;
  version: string;
  description?: string;
  contract_schema?: string;
  entrypoint?: string;
  resilience_tier?: string;
  recovery_policy?: Record<string, unknown>;
  capabilities?: Array<{ op?: string; timeout_ms?: number }>;
}

export interface ActuatorCatalogEntry {
  n: string;
  path: string;
  d: string;
  s: 'implemented';
  version: string;
  capability_count: number;
  ops: string[];
  contract_schema?: string;
  entrypoint?: string;
  manifest_path: string;
}

/** Manifest ids become directory components in the dispatch module path. */
export function isSafeActuatorId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value.trim());
}

const DEFAULT_ACTUATORS_DIR = pathResolver.rootResolve('libs/actuators');
const ACTUATOR_MANIFEST_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/actuator-manifest.schema.json'
);
const catalogCache = new Map<string, ActuatorCatalogEntry[]>();
const manifestCatalogCache = new Map<string, GovernedCatalog<ActuatorManifestFile>>();

function readManifest(manifestPath: string): ActuatorManifestFile {
  const safeManifestPath = assertSafeRepositoryPath(manifestPath);
  let catalog = manifestCatalogCache.get(safeManifestPath);
  if (!catalog) {
    catalog = defineCatalog<ActuatorManifestFile>({
      id: 'actuator-manifest',
      path: safeManifestPath,
      schema: ACTUATOR_MANIFEST_SCHEMA_PATH,
    });
    manifestCatalogCache.set(safeManifestPath, catalog);
  }
  return catalog.load();
}

function listOps(manifest: ActuatorManifestFile): string[] {
  return Array.from(
    new Set(
      (manifest.capabilities || []).map((capability) => String(capability.op || '')).filter(Boolean)
    )
  ).sort();
}

export function loadActuatorManifestCatalog(
  actuatorsDir = DEFAULT_ACTUATORS_DIR
): ActuatorCatalogEntry[] {
  const dir = assertSafeRepositoryPath(pathResolver.rootResolve(actuatorsDir), {
    allowMissingLeaf: true,
  });
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
    const actuatorDir = assertSafeRepositoryPath(path.join(dir, entry));
    if (!safeStat(actuatorDir).isDirectory()) {
      continue;
    }

    const manifestPath = assertSafeRepositoryPath(path.join(actuatorDir, 'manifest.json'));
    if (!safeExistsSync(manifestPath)) {
      continue;
    }

    const manifest = readManifest(manifestPath);
    if (!manifest.actuator_id) {
      continue;
    }
    if (!isSafeActuatorId(manifest.actuator_id)) {
      throw new Error(`[ACTUATOR_MANIFEST_SCOPE] invalid actuator id: ${manifest.actuator_id}`);
    }

    catalog.push({
      n: manifest.actuator_id,
      path: path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry),
      d: manifest.description || 'No description available.',
      s: 'implemented',
      version: manifest.version || '0.0.0',
      capability_count: Array.isArray(manifest.capabilities) ? manifest.capabilities.length : 0,
      ops: listOps(manifest),
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
    u: nowIso(),
    actuators: entries.map(({ manifest_path: _manifestPath, ...entry }) => entry),
  };
}
