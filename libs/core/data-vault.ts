import * as crypto from 'node:crypto';
import * as nodePath from 'node:path';
import { shared } from './path-resolver.js';
import {
  safeReadFile,
  safeWriteFile,
  safeExistsSync,
  safeMkdir,
  safeUnlinkSync,
  safeReaddir,
} from './secure-io.js';
import { logger } from './core.js';

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
  return crypto
    .createHash('sha256')
    .update(`${sourceType}::${projectId}::${key}`)
    .digest('hex')
    .slice(0, 32) + '.json';
}

function entryFilePath(sourceType: string, key: string, projectId: string): string {
  return nodePath.join(vaultDir(), entryFileName(sourceType, key, projectId));
}

function nowIso(): string {
  return new Date().toISOString();
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
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    return JSON.parse(raw) as VaultEntry<T>;
  } catch {
    return null;
  }
}

function writeEntryFile(filePath: string, entry: VaultEntry): void {
  const dir = nodePath.dirname(filePath);
  safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(entry, null, 2));
}

export async function fetchWithVaultCache<T>(
  sourceType: string,
  key: string,
  loader: () => Promise<T> | T,
  options: FetchWithVaultCacheOptions = {},
): Promise<FetchWithVaultCacheResult<T>> {
  const projectId = options.projectId ?? '_global';
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
    tier: options.tier ?? 'confidential',
    data,
    contentHash: sha256Hex(data),
    createdAt: nowIso(),
    ...(ttlMs > 0 ? { expiresAt: new Date(Date.now() + ttlMs).toISOString() } : {}),
  };

  writeEntryFile(filePath, entry);
  return { data, fromCache: false, entry };
}

export function getVaultEntry(sourceType: string, key: string, projectId: string): VaultEntry | null {
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
