import * as path from 'node:path';

import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { readJson } from '../foundation/json.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir, safeStat } from '../secure-io.js';

/**
 * Canonical service binding auth modes. Single source for the
 * `ServiceBinding.authMode` union (mirrors the `auth_mode` enum in
 * `knowledge/product/schemas/service-binding-record.schema.json`).
 */
export const SERVICE_AUTH_MODES = ['none', 'secret-guard', 'session'] as const;
export type ServiceAuthMode = (typeof SERVICE_AUTH_MODES)[number];

/**
 * Catalog-governed HTTP auth strategies. Mirrors the `auth_strategy` enum in
 * `knowledge/product/schemas/service-endpoints.schema.json`; the service
 * engine compares these case-insensitively.
 */
export const SERVICE_AUTH_STRATEGIES = [
  'none',
  'bearer',
  'Bearer',
  'basic',
  'Basic',
  'Bot',
  'session',
  'api_key_query',
  'AWS_SIGV4',
  'host-managed',
] as const;
export type ServiceAuthStrategy = (typeof SERVICE_AUTH_STRATEGIES)[number];

export const CREDENTIAL_SUFFIX_KEYS = [
  'accessToken',
  'appToken',
  'refreshToken',
  'clientId',
  'clientSecret',
  'redirectUri',
] as const;
export type CredentialSuffixKey = (typeof CREDENTIAL_SUFFIX_KEYS)[number];
export type CredentialSuffixMap = Record<CredentialSuffixKey, string[]>;

export interface ServiceEndpointRecord {
  base_url?: string;
  preset_path?: string;
  allow_unsafe_cli?: boolean;
  allow_local_network?: boolean;
  allow_stream_ingress?: boolean;
  auth_strategy?: ServiceAuthStrategy;
  intent_aliases?: string[];
  headers?: Record<string, string>;
  oauth?: Record<string, unknown>;
  credential_suffixes?: Partial<Record<CredentialSuffixKey, string[]>>;
  [key: string]: unknown;
}

export interface ServiceEndpointsCatalog {
  version?: string;
  default_pattern: string;
  services: Record<string, ServiceEndpointRecord>;
}

/** A catalog whose service records are guaranteed to carry credential suffixes. */
export interface ResolvedServiceEndpointRecord extends ServiceEndpointRecord {
  credential_suffixes: CredentialSuffixMap;
}

export interface ResolvedServiceEndpointsCatalog {
  version?: string;
  default_pattern: string;
  services: Record<string, ResolvedServiceEndpointRecord>;
}

const DEFAULT_SERVICE_ENDPOINTS_PATH = pathResolver.knowledge(
  'product/orchestration/service-endpoints.json'
);
const DEFAULT_SERVICE_ENDPOINTS_DIR = pathResolver.knowledge(
  'product/orchestration/service-endpoints'
);
const SERVICE_ENDPOINTS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/service-endpoints.schema.json'
);

let cachedServiceEndpointsPath: string | null = null;
let cachedServiceEndpointsDir: string | null = null;
let cachedServiceEndpoints: ServiceEndpointsCatalog | null = null;

function getServiceEndpointsPath(): string {
  return (
    getRegisteredEnvText('KYBERION_SERVICE_ENDPOINTS_PATH')?.trim() ||
    DEFAULT_SERVICE_ENDPOINTS_PATH
  );
}

function getServiceEndpointsDir(): string {
  return (
    getRegisteredEnvText('KYBERION_SERVICE_ENDPOINTS_DIR')?.trim() || DEFAULT_SERVICE_ENDPOINTS_DIR
  );
}

const serviceEndpointsCatalog = defineCatalog<ServiceEndpointsCatalog>({
  id: 'service-endpoints',
  path: () =>
    assertSafeRepositoryPath(pathResolver.rootResolve(getServiceEndpointsPath()), {
      allowMissingLeaf: true,
    }),
  schema: SERVICE_ENDPOINTS_SCHEMA_PATH,
});

/**
 * Canonical credential-suffix fallbacks, read from the schema defaults in
 * `knowledge/product/schemas/service-endpoints.schema.json` (`credential_suffixes`
 * object-level and per-key `default` keywords). The endpoint registry is the
 * only place that knows these values; binding resolution never hardcodes them.
 * Missing schema defaults are an explicit error, never a silent empty fallback.
 */
let cachedCredentialSuffixDefaults: CredentialSuffixMap | null = null;

export function getCredentialSuffixSchemaDefaults(): CredentialSuffixMap {
  if (cachedCredentialSuffixDefaults) return cachedCredentialSuffixDefaults;
  let properties: Record<string, { default?: unknown }> | undefined;
  try {
    const schema = readJson<{
      properties?: {
        services?: {
          additionalProperties?: {
            properties?: {
              credential_suffixes?: {
                default?: unknown;
                properties?: Record<string, { default?: unknown }>;
              };
            };
          };
        };
      };
    }>(SERVICE_ENDPOINTS_SCHEMA_PATH);
    const suffixSchema =
      schema?.properties?.services?.additionalProperties?.properties?.credential_suffixes;
    properties = suffixSchema?.properties;
    const objectDefault =
      suffixSchema?.default && typeof suffixSchema.default === 'object'
        ? (suffixSchema.default as Record<string, unknown>)
        : undefined;
    const defaults = {} as CredentialSuffixMap;
    for (const key of CREDENTIAL_SUFFIX_KEYS) {
      const objectValue = objectDefault?.[key];
      const keyValue = properties?.[key]?.default;
      const raw = Array.isArray(objectValue) ? objectValue : keyValue;
      if (
        key !== 'appToken' &&
        (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string' || !entry.trim()))
      ) {
        throw new Error(`Missing or invalid credential suffix default for ${key}`);
      }
      defaults[key] = Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === 'string')
        : [];
    }
    cachedCredentialSuffixDefaults = defaults;
    return defaults;
  } catch (error: any) {
    throw new Error(
      `[SERVICE_ENDPOINTS_SCHEMA] credential suffix defaults are unavailable: ${error?.message || error}`
    );
  }
}

export function _resetCredentialSuffixSchemaDefaultsForTests(): void {
  cachedCredentialSuffixDefaults = null;
}

/** Fill a raw record's suffixes from the schema defaults (record wins per key). */
export function normalizeServiceCredentialSuffixes(
  suffixes: ServiceEndpointRecord['credential_suffixes']
): CredentialSuffixMap {
  const defaults = getCredentialSuffixSchemaDefaults();
  const normalized = {} as CredentialSuffixMap;
  for (const key of CREDENTIAL_SUFFIX_KEYS) {
    normalized[key] = [...(suffixes?.[key] ?? defaults[key])];
  }
  return normalized;
}

function normalizeServiceEndpointRecord(
  serviceId: string,
  record: ServiceEndpointRecord
): ResolvedServiceEndpointRecord {
  return {
    ...record,
    credential_suffixes: normalizeServiceCredentialSuffixes(record.credential_suffixes),
  };
}

function loadServiceEndpointsCatalogFromPath(catalogPath: string): ServiceEndpointsCatalog {
  try {
    return defineCatalog<ServiceEndpointsCatalog>({
      id: 'service-endpoints-entry',
      path: () =>
        assertSafeRepositoryPath(pathResolver.rootResolve(catalogPath), {
          allowMissingLeaf: true,
        }),
      schema: SERVICE_ENDPOINTS_SCHEMA_PATH,
    }).load();
  } catch (error: any) {
    throw new Error(
      `Failed to load service endpoints catalog at ${catalogPath}: ${error?.message || error}`
    );
  }
}

function loadServiceEndpointsDirectory(catalogDir: string): ServiceEndpointsCatalog {
  const dir = assertSafeRepositoryPath(pathResolver.rootResolve(catalogDir), {
    allowMissingLeaf: true,
  });
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
    const filePath = assertSafeRepositoryPath(path.join(dir, file));
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
    services[serviceId] = normalizeServiceEndpointRecord(
      serviceId,
      serviceEntries[serviceId] as ServiceEndpointRecord
    );
  }

  if (Object.keys(services).length === 0) {
    throw new Error(`Service endpoints directory produced no services: ${dir}`);
  }

  return {
    version: version || '1.0.0',
    default_pattern: defaultPattern,
    services,
  };
}

export function loadServiceEndpointsDirectoryCatalog(
  catalogDir = DEFAULT_SERVICE_ENDPOINTS_DIR
): ResolvedServiceEndpointsCatalog {
  return loadServiceEndpointsDirectory(catalogDir) as ResolvedServiceEndpointsCatalog;
}

export function loadServiceEndpointsCatalog(): ResolvedServiceEndpointsCatalog {
  const catalogPath = getServiceEndpointsPath();
  const catalogDir = getServiceEndpointsDir();
  if (
    cachedServiceEndpointsPath === catalogPath &&
    cachedServiceEndpointsDir === catalogDir &&
    cachedServiceEndpoints
  ) {
    return cachedServiceEndpoints as ResolvedServiceEndpointsCatalog;
  }

  const normalizeCatalog = (parsed: ServiceEndpointsCatalog): ResolvedServiceEndpointsCatalog => ({
    ...parsed,
    services: Object.fromEntries(
      Object.entries(parsed.services || {}).map(([serviceId, record]) => [
        serviceId,
        normalizeServiceEndpointRecord(serviceId, record),
      ])
    ),
  });

  if (
    catalogPath === DEFAULT_SERVICE_ENDPOINTS_PATH &&
    safeExistsSync(
      assertSafeRepositoryPath(pathResolver.rootResolve(catalogDir), { allowMissingLeaf: true })
    )
  ) {
    const resolvedCatalogDir = assertSafeRepositoryPath(pathResolver.rootResolve(catalogDir));
    const dirEntries = safeReaddir(resolvedCatalogDir);
    const hasJsonFiles = dirEntries.some((entry) => entry.endsWith('.json'));
    if (hasJsonFiles) {
      const parsed = normalizeCatalog(
        loadServiceEndpointsDirectory(catalogDir) as ServiceEndpointsCatalog
      );
      cachedServiceEndpointsPath = catalogPath;
      cachedServiceEndpointsDir = catalogDir;
      cachedServiceEndpoints = parsed as unknown as ServiceEndpointsCatalog;
      return parsed;
    }
  }

  const parsed = normalizeCatalog(serviceEndpointsCatalog.load());
  cachedServiceEndpointsPath = catalogPath;
  cachedServiceEndpointsDir = catalogDir;
  cachedServiceEndpoints = parsed as unknown as ServiceEndpointsCatalog;
  return parsed;
}

export function getServiceEndpointRecord(serviceId: string): ResolvedServiceEndpointRecord | null {
  return loadServiceEndpointsCatalog().services?.[serviceId] || null;
}

export function getServiceEndpointRecordForIntent(
  intentId: string
): ResolvedServiceEndpointRecord | null {
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
