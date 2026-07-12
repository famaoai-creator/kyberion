import * as path from 'node:path';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat } from './secure-io.js';
import { createLogger } from './logger.js';

const logger = createLogger('service-endpoint-registry');

export interface ServiceEndpointRecord {
  base_url?: string;
  preset_path?: string;
  allow_unsafe_cli?: boolean;
  allow_local_network?: boolean;
  allow_stream_ingress?: boolean;
  auth_strategy?: string;
  intent_aliases?: string[];
  headers?: Record<string, string>;
  oauth?: Record<string, unknown>;
  credential_suffixes?: Partial<
    Record<
      'accessToken' | 'appToken' | 'refreshToken' | 'clientId' | 'clientSecret' | 'redirectUri',
      string[]
    >
  >;
  [key: string]: unknown;
}

export interface ServiceEndpointsCatalog {
  version?: string;
  default_pattern: string;
  services: Record<string, ServiceEndpointRecord>;
}

const DEFAULT_SERVICE_ENDPOINTS_PATH = pathResolver.knowledge(
  'product/orchestration/service-endpoints.json'
);
const DEFAULT_SERVICE_ENDPOINTS_DIR = pathResolver.knowledge(
  'product/orchestration/service-endpoints'
);
const FALLBACK_SERVICE_ENDPOINTS: ServiceEndpointsCatalog = {
  version: 'fallback',
  default_pattern: 'https://api.{service_id}.com/v1',
  services: {},
};

let cachedServiceEndpointsPath: string | null = null;
let cachedServiceEndpointsDir: string | null = null;
let cachedServiceEndpoints: ServiceEndpointsCatalog | null = null;

function getServiceEndpointsPath(): string {
  return process.env.KYBERION_SERVICE_ENDPOINTS_PATH?.trim() || DEFAULT_SERVICE_ENDPOINTS_PATH;
}

function getServiceEndpointsDir(): string {
  return process.env.KYBERION_SERVICE_ENDPOINTS_DIR?.trim() || DEFAULT_SERVICE_ENDPOINTS_DIR;
}

function loadServiceEndpointsCatalogFromPath(catalogPath: string): ServiceEndpointsCatalog {
  try {
    return JSON.parse(
      safeReadFile(pathResolver.rootResolve(catalogPath), { encoding: 'utf8' }) as string
    ) as ServiceEndpointsCatalog;
  } catch (error: any) {
    throw new Error(
      `Failed to load service endpoints catalog at ${catalogPath}: ${error?.message || error}`
    );
  }
}

function loadServiceEndpointsDirectory(catalogDir: string): ServiceEndpointsCatalog {
  const dir = pathResolver.rootResolve(catalogDir);
  if (!safeExistsSync(dir)) {
    throw new Error(`Service endpoints directory not found: ${dir}`);
  }

  const files = safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`Service endpoints directory is empty: ${dir}`);
  }

  const services: Record<string, ServiceEndpointRecord> = {};
  let version = '';
  let defaultPattern = '';

  for (const file of files) {
    const filePath = pathResolver.rootResolve(path.join(dir, file));
    if (!safeStat(filePath).isFile()) continue;

    const parsed = loadServiceEndpointsCatalogFromPath(filePath);
    const serviceEntries = parsed.services || {};
    const serviceIds = Object.keys(serviceEntries);
    if (serviceIds.length !== 1) {
      throw new Error(`Service endpoints file ${file} must contain exactly one service`);
    }

    const serviceId = serviceIds[0];
    const fileBase = file.replace(/\.json$/i, '');
    if (fileBase !== serviceId) {
      throw new Error(`Service endpoints file ${file} must match service id ${serviceId}`);
    }

    if (parsed.version && !version) {
      version = parsed.version;
    } else if (parsed.version && parsed.version !== version) {
      throw new Error(`Service endpoints version mismatch in ${file}`);
    }

    if (!defaultPattern) {
      defaultPattern = parsed.default_pattern;
    } else if (parsed.default_pattern !== defaultPattern) {
      throw new Error(`Service endpoints default_pattern mismatch in ${file}`);
    }

    if (services[serviceId]) {
      throw new Error(`Duplicate service endpoints entry for ${serviceId}`);
    }
    services[serviceId] = serviceEntries[serviceId];
  }

  if (!version) {
    throw new Error(`Service endpoints directory produced no services: ${dir}`);
  }

  return {
    version: version || '1.0.0',
    default_pattern: defaultPattern,
    services,
  };
}

export function loadServiceEndpointsCatalog(): ServiceEndpointsCatalog {
  const catalogPath = getServiceEndpointsPath();
  const catalogDir = getServiceEndpointsDir();
  if (
    cachedServiceEndpointsPath === catalogPath &&
    cachedServiceEndpointsDir === catalogDir &&
    cachedServiceEndpoints
  ) {
    return cachedServiceEndpoints;
  }

  if (
    catalogPath === DEFAULT_SERVICE_ENDPOINTS_PATH &&
    safeExistsSync(pathResolver.rootResolve(catalogDir))
  ) {
    const dirEntries = safeReaddir(pathResolver.rootResolve(catalogDir));
    const hasJsonFiles = dirEntries.some((entry) => entry.endsWith('.json'));
    if (hasJsonFiles) {
      try {
        const parsed = loadServiceEndpointsDirectory(catalogDir);
        cachedServiceEndpointsPath = catalogPath;
        cachedServiceEndpointsDir = catalogDir;
        cachedServiceEndpoints = parsed;
        return parsed;
      } catch (_) {
        // Fall back to the compatibility snapshot silently. The directory may
        // be partially migrated or intentionally empty during staged rollout.
      }
    }
  }

  const resolvedCatalogPath = pathResolver.rootResolve(catalogPath);
  if (!safeExistsSync(resolvedCatalogPath)) {
    cachedServiceEndpointsPath = catalogPath;
    cachedServiceEndpointsDir = catalogDir;
    cachedServiceEndpoints = FALLBACK_SERVICE_ENDPOINTS;
    return cachedServiceEndpoints;
  }

  try {
    const parsed = loadServiceEndpointsCatalogFromPath(catalogPath);
    cachedServiceEndpointsPath = catalogPath;
    cachedServiceEndpointsDir = catalogDir;
    cachedServiceEndpoints = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`failed to load catalog at ${catalogPath}: ${error.message}`);
    cachedServiceEndpointsPath = catalogPath;
    cachedServiceEndpointsDir = catalogDir;
    cachedServiceEndpoints = FALLBACK_SERVICE_ENDPOINTS;
    return cachedServiceEndpoints;
  }
}

export function getServiceEndpointRecord(serviceId: string): ServiceEndpointRecord | null {
  return loadServiceEndpointsCatalog().services?.[serviceId] || null;
}

export function getServiceEndpointRecordForIntent(intentId: string): ServiceEndpointRecord | null {
  const normalizedIntent = intentId.trim();
  if (!normalizedIntent) return null;
  const catalog = loadServiceEndpointsCatalog();

  if (catalog.services[normalizedIntent]) {
    return catalog.services[normalizedIntent];
  }

  for (const record of Object.values(catalog.services)) {
    const aliases = Array.isArray(record.intent_aliases) ? record.intent_aliases : [];
    if (aliases.some((alias) => alias === normalizedIntent)) {
      return record;
    }
  }

  return null;
}

export function resolveServiceIdForIntent(intentId: string): string | null {
  const record = getServiceEndpointRecordForIntent(intentId);
  if (!record) return null;
  const catalog = loadServiceEndpointsCatalog();
  const entries = Object.entries(catalog.services);
  for (const [serviceId, serviceRecord] of entries) {
    if (serviceRecord === record) return serviceId;
  }
  return null;
}
