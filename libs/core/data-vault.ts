export type DataVaultTier = 'personal' | 'confidential' | 'public';

export interface VaultEntry<T = unknown> {
  vault_id: string;
  cache_key: string;
  data: T;
  tier: DataVaultTier;
  created_at: string;
  expires_at: string;
}

export interface FetchWithVaultCacheOptions {
  ttlMs?: number;
  projectId?: string;
  tier?: DataVaultTier;
}

export interface FetchWithVaultCacheResult<T = unknown> {
  data: T;
  fromCache: boolean;
}

export interface VaultEntryFilter {
  vault_id?: string;
  cache_key?: string;
  tier?: DataVaultTier;
}

const VAULT = new Map<string, VaultEntry>();

function nowIso(): string {
  return new Date().toISOString();
}

function makeKey(vaultId: string, cacheKey: string): string {
  return `${vaultId}::${cacheKey}`;
}

export async function fetchWithVaultCache<T>(
  vaultId: string,
  cacheKey: string,
  loader: () => Promise<T> | T,
  options: FetchWithVaultCacheOptions = {}
): Promise<FetchWithVaultCacheResult<T>> {
  const key = makeKey(vaultId, cacheKey);
  const cached = VAULT.get(key);
  const expiresAtMs = cached ? Date.parse(cached.expires_at) : Number.NaN;
  if (cached && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
    return { data: cached.data as T, fromCache: true };
  }

  const data = await loader();
  const ttlMs = Math.max(0, Number(options.ttlMs ?? 0));
  const entry: VaultEntry<T> = {
    vault_id: vaultId,
    cache_key: cacheKey,
    data,
    tier: options.tier ?? 'confidential',
    created_at: nowIso(),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
  VAULT.set(key, entry);
  return { data, fromCache: false };
}

export function getVaultEntry(vaultId: string, cacheKey: string): VaultEntry | undefined {
  return VAULT.get(makeKey(vaultId, cacheKey));
}

export function invalidateVaultEntry(vaultId: string, cacheKey: string): boolean {
  return VAULT.delete(makeKey(vaultId, cacheKey));
}

export function listVaultEntries(filter: VaultEntryFilter = {}): VaultEntry[] {
  return [...VAULT.values()].filter((entry) => {
    if (filter.vault_id && entry.vault_id !== filter.vault_id) return false;
    if (filter.cache_key && entry.cache_key !== filter.cache_key) return false;
    if (filter.tier && entry.tier !== filter.tier) return false;
    return true;
  });
}
