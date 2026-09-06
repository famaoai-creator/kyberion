import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { knowledge, shared } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

const BASELINE_CACHE_DIR = 'runtime/baseline-check-cache';

const CACHE_SCHEMAS = {
  'tenant-drift': knowledge('product/schemas/tenant-drift-cache.schema.json'),
  'cowork-health': knowledge('product/schemas/cowork-health-cache.schema.json'),
} as const;

export type BaselineCacheName = keyof typeof CACHE_SCHEMAS;

export interface BaselineCacheEnvelope<T> {
  computed_at: string;
  ttl_ms: number;
  value: T;
}

export interface BaselineCacheSnapshot<T> {
  value: T;
  cached: boolean;
  age_ms?: number;
}

function cachePath(name: BaselineCacheName): string {
  return shared(`${BASELINE_CACHE_DIR}/${name}.json`);
}

function cacheCatalog<T>(name: BaselineCacheName, filePath: string) {
  return defineCatalog<BaselineCacheEnvelope<T>>({
    id: `baseline-cache-${name}`,
    path: filePath,
    schema: CACHE_SCHEMAS[name],
  });
}

export function loadBaselineCache<T>(name: BaselineCacheName): BaselineCacheSnapshot<T> | null {
  const filePath = assertSafeRepositoryPath(cachePath(name), { allowMissingLeaf: true });
  if (!safeExistsSync(filePath)) return null;
  try {
    if (!safeLstat(filePath).isFile()) return null;
    const parsed = cacheCatalog<T>(name, filePath).load();
    const computedAt = Date.parse(parsed.computed_at);
    if (!Number.isFinite(computedAt)) return null;
    const ageMs = Date.now() - computedAt;
    if (ageMs > parsed.ttl_ms) return null;
    return { value: parsed.value, cached: true, age_ms: ageMs };
  } catch {
    return null;
  }
}

export function storeBaselineCache<T>(name: BaselineCacheName, value: T, ttlMs: number): void {
  const filePath = assertSafeRepositoryPath(cachePath(name), { allowMissingLeaf: true });
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`Baseline cache must be a regular file: ${filePath}`);
  }
  const envelope = cacheCatalog<T>(name, filePath).validate(
    { computed_at: nowIso(), ttl_ms: ttlMs, value },
    filePath
  );
  safeWriteFile(filePath, JSON.stringify(envelope, null, 2));
}
