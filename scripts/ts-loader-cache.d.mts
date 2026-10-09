export const TS_LOADER_CACHE_ENTRY_EXTENSION: string;

export const TS_LOADER_CACHE_MAX_AGE_MS: number;

export function tsLoaderFastResolveEnabled(env?: NodeJS.ProcessEnv): boolean;

export function tsLoaderCacheDir(env?: NodeJS.ProcessEnv, projectRoot?: string): string | null;

export function tsLoaderCacheKey(filePath: string, source: string): string;

export function pruneTsLoaderCache(
  dir: string,
  options?: { now?: number; maxAgeMs?: number; force?: boolean }
): number;

export function transpileWithCache(
  filePath: string,
  source: string,
  options?: { env?: NodeJS.ProcessEnv; projectRoot?: string; expectedUid?: number | null }
): { outputText: string; cacheHit: boolean };

export function isTrustedStat(stat: { uid: number; mode: number }, uid: number | null): boolean;

export function preservesSymlinks(execArgv?: readonly string[], env?: NodeJS.ProcessEnv): boolean;
