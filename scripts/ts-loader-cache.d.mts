export const TS_LOADER_CACHE_VERSION: string;

export const TS_LOADER_CACHE_ENTRY_EXTENSION: string;

export function tsLoaderCacheDir(env?: NodeJS.ProcessEnv): string | null;

export function tsLoaderCacheKey(filePath: string, source: string): string;

export function transpileWithCache(
  filePath: string,
  source: string,
  options?: { env?: NodeJS.ProcessEnv; projectRoot?: string }
): { outputText: string; cacheHit: boolean };
