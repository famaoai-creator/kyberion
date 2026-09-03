import * as crypto from 'node:crypto';
import * as nodePath from 'node:path';
import { knowledge, shared } from './path-resolver.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import {
  safeWriteFile,
  safeExistsSync,
  safeMkdir,
  safeUnlinkSync,
  safeReaddir,
} from './secure-io.js';
import { logger } from './core.js';
import { nowIso } from './foundation/time.js';

export type DataVaultTier = 'personal' | 'confidential' | 'public';

export interface VaultEntry<T = unknown> {
  sourceType: string;
  key: string;
  projectId: string;
  tier: DataVaultTier;
  data: T;
  contentHash: string;
  createdAt: string;
  expiresAt?: string;
}

export interface FetchWithVaultCacheOptions {
  ttlMs?: number;
  projectId?: string;
  tier?: DataVaultTier;
}

export interface FetchWithVaultCacheResult<T = unknown> {
  data: T;
  fromCache: boolean;
  entry: VaultEntry<T>;
}

export interface VaultEntryFilter {
  sourceType?: string;
  projectId?: string;
  includeExpired?: boolean;
  /** @deprecated use sourceType */
  vault_id?: string;
  /** @deprecated use key */
  cache_key?: string;
  tier?: DataVaultTier;
}

function vaultDir(): string {
  return shared('data-vault');
}

function entryFileName(sourceType: string, key: string, projectId: string): string {
  return (
    crypto
      .createHash('sha256')
      .update(`${sourceType}::${projectId}::${key}`)
      .digest('hex')
      .slice(0, 32) + '.json'
  );
}

function entryFilePath(sourceType: string, key: string, projectId: string): string {
  return nodePath.join(vaultDir(), entryFileName(sourceType, key, projectId));
}

const VAULT_ENTRY_FIELDS = [
  'sourceType',
  'key',
  'projectId',
  'tier',
  'data',
  'contentHash',
  'createdAt',
  'expiresAt',
] as const;

const VAULT_ENTRY_SCHEMA_PATH = knowledge('product/schemas/data-vault-entry.schema.json');

function vaultEntryCatalogAtPath(filePath: string) {
  return defineCatalog<VaultEntry>({
    id: 'data-vault-entry',
    path: filePath,
    schema: VAULT_ENTRY_SCHEMA_PATH,
  });
}

function requiredEntryString(
  record: Record<string, unknown>,
  field: string,
  label: string
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function parseVaultEntry(value: unknown, filePath: string): VaultEntry {
  const label = `data-vault entry ${filePath}`;
  const record = parseSafeJsonObjectValue(value, label);
  const allowed = new Set<string>(VAULT_ENTRY_FIELDS);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unknown fields`);
  }
  if (!Object.hasOwn(record, 'data')) throw new Error(`${label}.data is required`);

  const sourceType = requiredEntryString(record, 'sourceType', label);
  const key = requiredEntryString(record, 'key', label);
  const projectId = requiredEntryString(record, 'projectId', label);
  const tier = record.tier;
  if (tier !== 'personal' && tier !== 'confidential' && tier !== 'public') {
    throw new Error(`${label}.tier is invalid`);
  }
  const contentHash = requiredEntryString(record, 'contentHash', label);
  if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error(`${label}.contentHash is invalid`);
  }
  const createdAt = requiredEntryString(record, 'createdAt', label);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`${label}.createdAt must be a valid timestamp`);
  }
  const expiresAt =
    record.expiresAt === undefined ? undefined : requiredEntryString(record, 'expiresAt', label);
  if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error(`${label}.expiresAt must be a valid timestamp`);
  }
  if (sha256Hex(record.data) !== contentHash) {
    throw new Error(`${label}.contentHash does not match data`);
  }
  if (entryFileName(sourceType, key, projectId) !== nodePath.basename(filePath)) {
    throw new Error(`${label} does not match its filename binding`);
  }
  return {
    sourceType,
    key,
    projectId,
    tier,
    data: record.data,
    contentHash,
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function sha256Hex(data: unknown): string {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function isExpired(entry: VaultEntry): boolean {
  if (!entry.expiresAt) return false;
  return Date.parse(entry.expiresAt) <= Date.now();
}

function readEntryFile<T>(filePath: string): VaultEntry<T> | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return parseVaultEntry(vaultEntryCatalogAtPath(filePath).load(), filePath) as VaultEntry<T>;
  } catch {
    return null;
  }
}

/** Read and validate one persisted vault entry for other governed consumers. */
export function loadVaultEntryAtPath<T = unknown>(filePath: string): VaultEntry<T> | null {
  return readEntryFile<T>(filePath);
}

function writeEntryFile(filePath: string, entry: VaultEntry): void {
  const dir = nodePath.dirname(filePath);
  safeMkdir(dir, { recursive: true });
  const validated = vaultEntryCatalogAtPath(filePath).validate(entry, filePath);
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
}

export async function fetchWithVaultCache<T>(
  sourceType: string,
  key: string,
  loader: () => Promise<T> | T,
  options: FetchWithVaultCacheOptions = {}
): Promise<FetchWithVaultCacheResult<T>> {
  const projectId = options.projectId ?? '_global';
  if (
    typeof sourceType !== 'string' ||
    typeof key !== 'string' ||
    typeof projectId !== 'string' ||
    !sourceType.trim() ||
    !key.trim() ||
    !projectId.trim()
  ) {
    throw new Error('data-vault sourceType, key, and projectId must be non-empty strings');
  }
  const tier = options.tier ?? 'confidential';
  if (tier !== 'personal' && tier !== 'confidential' && tier !== 'public') {
    throw new Error(`data-vault tier is invalid: ${String(tier)}`);
  }
  const filePath = entryFilePath(sourceType, key, projectId);

  const cached = readEntryFile<T>(filePath);
  if (cached && !isExpired(cached)) {
    logger.info(`[DATA-VAULT] cache hit: ${sourceType}:${key}`);
    return { data: cached.data, fromCache: true, entry: cached };
  }

  const data = await loader();
  const ttlMs = Number(options.ttlMs ?? 0);
  const entry: VaultEntry<T> = {
    sourceType,
    key,
    projectId,
    tier,
    data,
    contentHash: sha256Hex(data),
    createdAt: nowIso(),
    ...(ttlMs > 0 ? { expiresAt: nowIso(new Date(Date.now() + ttlMs)) } : {}),
  };

  writeEntryFile(filePath, entry);
  return { data, fromCache: false, entry };
}

export function getVaultEntry(
  sourceType: string,
  key: string,
  projectId: string
): VaultEntry | null {
  const filePath = entryFilePath(sourceType, key, projectId);
  const entry = readEntryFile(filePath);
  if (!entry) return null;
  if (isExpired(entry)) return null;
  return entry;
}

export function invalidateVaultEntry(sourceType: string, key: string, projectId: string): boolean {
  const filePath = entryFilePath(sourceType, key, projectId);
  if (!safeExistsSync(filePath)) return false;
  safeUnlinkSync(filePath);
  return true;
}

export function listVaultEntries(filter: VaultEntryFilter = {}): VaultEntry[] {
  const dir = vaultDir();
  if (!safeExistsSync(dir)) return [];

  let files: string[];
  try {
    files = safeReaddir(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const entries: VaultEntry[] = [];
  for (const file of files) {
    const entry = readEntryFile(nodePath.join(dir, file));
    if (!entry) continue;
    if (!filter.includeExpired && isExpired(entry)) continue;
    if (filter.sourceType && entry.sourceType !== filter.sourceType) continue;
    if (filter.projectId && entry.projectId !== filter.projectId) continue;
    if (filter.tier && entry.tier !== filter.tier) continue;
    entries.push(entry);
  }
  return entries;
}
