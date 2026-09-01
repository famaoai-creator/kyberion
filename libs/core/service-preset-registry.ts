import * as path from 'node:path';

import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir, safeStat } from './secure-io.js';
import { loadServiceEndpointsCatalog } from './service-binding.js';

export interface ServicePresetRecord {
  service_id: string;
  name?: string;
  description?: string;
  auth_strategy?: string;
  setup_hint?: string;
  allow_unsafe_cli?: boolean;
  allow_local_network?: boolean;
  fallback_strategy?: string;
  headers?: Record<string, string>;
  operations: Record<string, any>;
  [key: string]: unknown;
}

export interface ServicePresetsCatalog {
  services: Record<string, ServicePresetRecord>;
}

const DEFAULT_SERVICE_PRESETS_DIR = pathResolver.knowledge('product/orchestration/service-presets');
const SERVICE_PRESETS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/service-presets.schema.json'
);

let cachedServicePresetsDir: string | null = null;
let cachedServicePresets: ServicePresetsCatalog | null = null;

function getServicePresetsDir(): string {
  return (
    getRegisteredEnvText('KYBERION_SERVICE_PRESETS_DIR')?.trim() || DEFAULT_SERVICE_PRESETS_DIR
  );
}

function loadPresetFromPath(presetPath: string): ServicePresetRecord {
  try {
    return defineCatalog<ServicePresetRecord>({
      id: 'service-preset',
      path: assertSafeRepositoryPath(pathResolver.rootResolve(presetPath), {
        allowMissingLeaf: true,
      }),
      schema: SERVICE_PRESETS_SCHEMA_PATH,
    }).load();
  } catch (error: any) {
    throw new Error(`Failed to load service preset at ${presetPath}: ${error?.message || error}`);
  }
}

function loadServicePresetsDirectory(catalogDir: string): ServicePresetsCatalog {
  const dir = assertSafeRepositoryPath(pathResolver.rootResolve(catalogDir), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(dir)) {
    throw new Error(`Service presets directory not found: ${dir}`);
  }

  const files = safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`Service presets directory is empty: ${dir}`);
  }

  const services: Record<string, ServicePresetRecord> = {};
  for (const file of files) {
    const filePath = assertSafeRepositoryPath(path.join(dir, file));
    if (!safeStat(filePath).isFile()) continue;

    const parsed = loadPresetFromPath(filePath);
    const serviceId = String(parsed.service_id || '').trim();
    if (!serviceId) {
      throw new Error(`Service preset file ${file} must define service_id`);
    }

    const fileBase = file.replace(/\.json$/i, '');
    if (fileBase !== serviceId) {
      throw new Error(`Service preset file ${file} must match service id ${serviceId}`);
    }

    if (services[serviceId]) {
      throw new Error(`Duplicate service preset entry for ${serviceId}`);
    }

    services[serviceId] = parsed;
  }

  return { services };
}

function loadServicePresetsFromEndpoints(): ServicePresetsCatalog {
  const endpoints = loadServiceEndpointsCatalog();
  const services: Record<string, ServicePresetRecord> = {};

  for (const [serviceId, endpoint] of Object.entries(endpoints.services || {})) {
    const presetPath = typeof endpoint?.preset_path === 'string' ? endpoint.preset_path.trim() : '';
    if (!presetPath) continue;
    try {
      const preset = loadPresetFromPath(presetPath);
      const resolvedServiceId = String(preset.service_id || serviceId).trim() || serviceId;
      services[resolvedServiceId] = preset;
    } catch (_) {
      // Keep falling back to explicit preset path lookups.
    }
  }

  return { services };
}

export function loadServicePresetsCatalog(): ServicePresetsCatalog {
  const catalogDir = getServicePresetsDir();
  if (cachedServicePresetsDir === catalogDir && cachedServicePresets) {
    return cachedServicePresets;
  }

  const resolvedCatalogDir = assertSafeRepositoryPath(pathResolver.rootResolve(catalogDir), {
    allowMissingLeaf: true,
  });
  if (safeExistsSync(resolvedCatalogDir)) {
    const dirEntries = safeReaddir(resolvedCatalogDir);
    const hasJsonFiles = dirEntries.some((entry) => entry.endsWith('.json'));
    if (hasJsonFiles) {
      try {
        const parsed = loadServicePresetsDirectory(catalogDir);
        cachedServicePresetsDir = catalogDir;
        cachedServicePresets = parsed;
        return parsed;
      } catch (_) {
        // Fall back to endpoint-linked presets during staged rollout.
      }
    }
  }

  const fallback = loadServicePresetsFromEndpoints();
  cachedServicePresetsDir = catalogDir;
  cachedServicePresets = fallback;
  return fallback;
}

export function getServicePresetRecord(
  serviceId: string,
  presetPathHint?: string
): ServicePresetRecord | null {
  const normalizedServiceId = serviceId.trim();
  if (!normalizedServiceId) return null;

  if (presetPathHint) {
    try {
      const parsed = loadPresetFromPath(presetPathHint);
      const presetServiceId =
        String(parsed.service_id || normalizedServiceId).trim() || normalizedServiceId;
      if (presetServiceId === normalizedServiceId || !parsed.service_id) {
        return parsed;
      }
    } catch (_) {
      /* best-effort cleanup */
    }
  }

  const catalog = loadServicePresetsCatalog();
  const direct = catalog.services[normalizedServiceId];
  if (direct) return direct;

  const endpointPresetPath =
    loadServiceEndpointsCatalog().services?.[normalizedServiceId]?.preset_path;
  if (typeof endpointPresetPath === 'string' && endpointPresetPath.trim()) {
    try {
      return loadPresetFromPath(endpointPresetPath);
    } catch (_) {
      /* best-effort cleanup */
    }
  }

  return null;
}

export function resolveServicePresetPath(
  serviceId: string,
  presetPathHint?: string
): string | null {
  if (presetPathHint) {
    const hintedPath = assertSafeRepositoryPath(pathResolver.rootResolve(presetPathHint), {
      allowMissingLeaf: true,
    });
    if (safeExistsSync(hintedPath)) return presetPathHint;
  }

  const catalogDir = getServicePresetsDir();
  const dirPath = pathResolver.rootResolve(path.join(catalogDir, `${serviceId}.json`));
  const safeDirPath = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
  if (safeExistsSync(safeDirPath)) {
    return path.join(catalogDir, `${serviceId}.json`);
  }

  const endpointPresetPath = loadServiceEndpointsCatalog().services?.[serviceId]?.preset_path;
  if (
    typeof endpointPresetPath === 'string' &&
    safeExistsSync(
      assertSafeRepositoryPath(pathResolver.rootResolve(endpointPresetPath), {
        allowMissingLeaf: true,
      })
    )
  ) {
    return endpointPresetPath;
  }

  return null;
}
