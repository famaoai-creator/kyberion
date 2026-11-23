/**
 * Service-preset TTL cache on the cache floor (runtime-storage-layout §2).
 *
 * Entries live at
 * `active/shared/cache/<tier>/<tenant|shared>/service-preset/<project/<id>|global>/<hash>.json`,
 * so the owner follows from the path: tier-guard / tenant_scope protect the
 * tenant partitions, the cache floor retention rule removes old files, and
 * offboarding removes a tenant's or project's subtree by path. Each entry also
 * carries its own `expiresAt`, checked on read (an expired entry is a miss
 * and is rewritten).
 */
import type { StorageDataTier } from '../storage-layout.js';
import * as crypto from 'node:crypto';
import * as nodePath from 'node:path';
import {
  STORAGE_DATA_TIERS,
  resolveStorageFloor,
  storageFloorRelativePath,
} from '../storage-layout.js';
import { knowledge } from '../path-resolver.js';
import { parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { safeWriteFile, safeExistsSync, safeMkdir, safeUnlinkSync } from '../secure-io.js';
import { logger } from '../core.js';
import { nowIso } from '../foundation/time.js';

/** Cache-floor domain segment owned by this module. */
export const SERVICE_PRESET_CACHE_DOMAIN = 'service-preset';
/** Subtree of project-scoped entries: `service-preset/project/<projectId>/`. */
export const SERVICE_PRESET_CACHE_PROJECT_SEGMENT = 'project';
/** Subtree of entries without a project: `service-preset/global/`. */
export const SERVICE_PRESET_CACHE_GLOBAL_SEGMENT = 'global';

/** Partition and project an entry is cached under. */
export interface ServicePresetCacheScope {
  tier: StorageDataTier;
  /** Tenant slug; omitted → the tier's untenanted `shared` partition. */
  tenant?: string;
  /** Project id; omitted → the partition's `global` subtree. */
  projectId?: string;
}

export interface ServicePresetCacheEntry<T = unknown> {
  serviceId: string;
  key: string;
  tier: StorageDataTier;
  tenant?: string;
  projectId?: string;
  data: T;
  contentHash: string;
  createdAt: string;
  expiresAt?: string;
}

export interface FetchWithServicePresetCacheResult<T = unknown> {
  data: T;
  fromCache: boolean;
  entry: ServicePresetCacheEntry<T>;
}

function normalizedScope(scope: ServicePresetCacheScope): ServicePresetCacheScope {
  if (!scope || !STORAGE_DATA_TIERS.includes(scope.tier)) {
    throw new Error(`[SERVICE_PRESET_CACHE_TIER_INVALID] '${String(scope?.tier)}'`);
  }
  const tenant = scope.tenant?.trim().toLowerCase() || undefined;
  const projectId = scope.projectId?.trim() || undefined;
  // One path segment: a separator would nest one project's subtree in another's.
  if (projectId && /[\\/]/u.test(projectId)) {
    throw new Error(`[SERVICE_PRESET_CACHE_PROJECT_INVALID] '${projectId}'`);
  }
  return {
    tier: scope.tier,
    ...(tenant ? { tenant } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

/**
 * Repo-relative `cache/<tier>/<tenant|shared>/service-preset` root of a
 * partition (throws for a non-slug tenant, like every floor path).
 */
export function servicePresetCachePartitionRoot(tier: StorageDataTier, tenant?: string): string {
  return storageFloorRelativePath(
    'cache',
    { kind: 'tier', tier, tenant },
    SERVICE_PRESET_CACHE_DOMAIN
  );
}

/** Repo-relative subtree of one project's entries inside a partition. */
export function servicePresetCacheProjectRoot(
  tier: StorageDataTier,
  tenant: string | undefined,
  projectId: string
): string {
  return storageFloorRelativePath(
    'cache',
    { kind: 'tier', tier, tenant },
    SERVICE_PRESET_CACHE_DOMAIN,
    SERVICE_PRESET_CACHE_PROJECT_SEGMENT,
    projectId
  );
}

function entryFileName(serviceId: string, key: string): string {
  return (
    crypto.createHash('sha256').update(`${serviceId}::${key}`).digest('hex').slice(0, 32) + '.json'
  );
}

function entryFilePath(serviceId: string, key: string, scope: ServicePresetCacheScope): string {
  const subtree = scope.projectId
    ? [SERVICE_PRESET_CACHE_PROJECT_SEGMENT, scope.projectId]
    : [SERVICE_PRESET_CACHE_GLOBAL_SEGMENT];
  return resolveStorageFloor(
    'cache',
    { kind: 'tier', tier: scope.tier, tenant: scope.tenant },
    SERVICE_PRESET_CACHE_DOMAIN,
    ...subtree,
    entryFileName(serviceId, key)
  );
}

const ENTRY_FIELDS = [
  'serviceId',
  'key',
  'tier',
  'tenant',
  'projectId',
  'data',
  'contentHash',
  'createdAt',
  'expiresAt',
] as const;

const ENTRY_SCHEMA_PATH = knowledge('product/schemas/service-preset-cache-entry.schema.json');

function entryCatalogAtPath(filePath: string) {
  return defineCatalog<ServicePresetCacheEntry>({
    id: 'service-preset-cache-entry',
    path: filePath,
    schema: ENTRY_SCHEMA_PATH,
  });
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  label: string
): string | undefined {
  return record[field] === undefined ? undefined : requiredString(record, field, label);
}

function sha256Hex(data: unknown): string {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * Parse one persisted entry and bind it to the location it was read from: the
 * file name must match (serviceId, key) and the recorded tier / tenant /
 * project must equal the partition the caller asked for, so a file copied into
 * another partition is never served there.
 */
function parseEntry(
  value: unknown,
  filePath: string,
  scope: ServicePresetCacheScope
): ServicePresetCacheEntry {
  const label = `service-preset cache entry ${filePath}`;
  const record = parseSafeJsonObjectValue(value, label);
  const allowed = new Set<string>(ENTRY_FIELDS);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unknown fields`);
  }
  if (!Object.hasOwn(record, 'data')) throw new Error(`${label}.data is required`);
  const serviceId = requiredString(record, 'serviceId', label);
  const key = requiredString(record, 'key', label);
  const tenant = optionalString(record, 'tenant', label);
  const projectId = optionalString(record, 'projectId', label);
  if (record.tier !== scope.tier || tenant !== scope.tenant || projectId !== scope.projectId) {
    throw new Error(`${label} does not match its partition`);
  }
  const contentHash = requiredString(record, 'contentHash', label);
  if (!/^sha256:[0-9a-f]{64}$/.test(contentHash) || sha256Hex(record.data) !== contentHash) {
    throw new Error(`${label}.contentHash does not match data`);
  }
  const createdAt = requiredString(record, 'createdAt', label);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`${label}.createdAt must be a valid timestamp`);
  }
  const expiresAt = optionalString(record, 'expiresAt', label);
  if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error(`${label}.expiresAt must be a valid timestamp`);
  }
  if (entryFileName(serviceId, key) !== nodePath.basename(filePath)) {
    throw new Error(`${label} does not match its filename binding`);
  }
  return {
    serviceId,
    key,
    tier: scope.tier,
    ...(tenant ? { tenant } : {}),
    ...(projectId ? { projectId } : {}),
    data: record.data,
    contentHash,
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function isExpired(entry: ServicePresetCacheEntry): boolean {
  return entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= Date.now();
}

function readEntry<T>(
  filePath: string,
  scope: ServicePresetCacheScope
): ServicePresetCacheEntry<T> | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return parseEntry(
      entryCatalogAtPath(filePath).load(),
      filePath,
      scope
    ) as ServicePresetCacheEntry<T>;
  } catch {
    return null;
  }
}

function assertIdentity(serviceId: string, key: string): void {
  if (
    typeof serviceId !== 'string' ||
    typeof key !== 'string' ||
    !serviceId.trim() ||
    !key.trim()
  ) {
    throw new Error('service-preset cache serviceId and key must be non-empty strings');
  }
}

/**
 * Serve `(serviceId, key)` from the scope's partition while its entry is
 * unexpired, otherwise call `loader` and store the result there. `ttlMs <= 0`
 * stores an entry without `expiresAt` (the cache floor TTL still applies).
 */
export async function fetchWithServicePresetCache<T>(
  serviceId: string,
  key: string,
  loader: () => Promise<T> | T,
  options: { scope: ServicePresetCacheScope; ttlMs?: number }
): Promise<FetchWithServicePresetCacheResult<T>> {
  assertIdentity(serviceId, key);
  const scope = normalizedScope(options.scope);
  const filePath = entryFilePath(serviceId, key, scope);

  const cached = readEntry<T>(filePath, scope);
  if (cached && !isExpired(cached)) {
    logger.debug(`[SERVICE_PRESET_CACHE] hit: ${serviceId}:${key}`);
    return { data: cached.data, fromCache: true, entry: cached };
  }

  const data = await loader();
  const ttlMs = Number(options.ttlMs ?? 0);
  const entry: ServicePresetCacheEntry<T> = {
    serviceId,
    key,
    ...scope,
    data,
    contentHash: sha256Hex(data),
    createdAt: nowIso(),
    ...(ttlMs > 0 ? { expiresAt: nowIso(new Date(Date.now() + ttlMs)) } : {}),
  };
  safeMkdir(nodePath.dirname(filePath), { recursive: true });
  const validated = entryCatalogAtPath(filePath).validate(entry, filePath);
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  return { data, fromCache: false, entry };
}

/** The unexpired entry of `(serviceId, key)` in the scope's partition, or null. */
export function getServicePresetCacheEntry(
  serviceId: string,
  key: string,
  scope: ServicePresetCacheScope
): ServicePresetCacheEntry | null {
  assertIdentity(serviceId, key);
  const normalized = normalizedScope(scope);
  const entry = readEntry(entryFilePath(serviceId, key, normalized), normalized);
  return entry && !isExpired(entry) ? entry : null;
}

/** Remove the entry of `(serviceId, key)` from the scope's partition. */
export function invalidateServicePresetCacheEntry(
  serviceId: string,
  key: string,
  scope: ServicePresetCacheScope
): boolean {
  assertIdentity(serviceId, key);
  const filePath = entryFilePath(serviceId, key, normalizedScope(scope));
  if (!safeExistsSync(filePath)) return false;
  safeUnlinkSync(filePath);
  return true;
}
