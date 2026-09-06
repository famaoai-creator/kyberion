import { useCallback, useEffect, useRef, useState } from 'react';
import { watch, type FSWatcher } from 'chokidar';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';

export interface PollWatchOptions<T> {
  load: () => Promise<T> | T;
  watchPaths?: string[];
  intervalMs?: number;
  debounceMs?: number;
  enabled?: boolean;
  refreshNonce?: number;
}

export interface PollWatchState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  refreshedAt?: number;
  refresh: () => void;
}

/** Resolve only repository-local regular files/directories for Chokidar. */
export function resolveWatchPaths(watchPaths: readonly string[]): string[] {
  return watchPaths.flatMap((watchPath) => {
    try {
      const safePath = assertSafeRepositoryPath(watchPath, { allowMissingLeaf: true });
      if (!safeExistsSync(safePath)) return [];
      const stat = safeLstat(safePath);
      return stat.isFile() || stat.isDirectory() ? [safePath] : [];
    } catch {
      return [];
    }
  });
}

export function usePollWatch<T>({
  load,
  watchPaths = [],
  intervalMs = 5000,
  debounceMs = 250,
  enabled = true,
  refreshNonce = 0,
}: PollWatchOptions<T>): PollWatchState<T> {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    loading: boolean;
    refreshedAt?: number;
  }>({ loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(() => setTick((current) => current + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadRef.current();
        if (!cancelled) {
          setState({ data, loading: false, refreshedAt: Date.now() });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setState((prev) => ({ ...prev, error: message, loading: false }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, enabled, refreshNonce]);

  const watchKey = watchPaths.join('|');
  useEffect(() => {
    if (!enabled) return;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, debounceMs);
    };
    let watcher: FSWatcher | undefined;
    const existing = resolveWatchPaths(watchPaths);
    if (existing.length > 0) {
      watcher = watch(existing, {
        ignoreInitial: true,
        depth: 3,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      watcher.on('all', bump);
      watcher.on('error', () => {
        /* watcher errors degrade to interval polling */
      });
    }
    const interval = setInterval(refresh, intervalMs);
    return () => {
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
      void watcher?.close();
    };
  }, [enabled, watchKey, intervalMs, debounceMs, refresh]);

  return { ...state, refresh };
}
