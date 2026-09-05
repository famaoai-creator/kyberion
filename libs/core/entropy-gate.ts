import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';

const CACHE_DIR = pathResolver.shared('entropy-cache');

function safeHashPath(key: string): string {
  if (!key || /[\\/]/u.test(key) || key === '.' || key === '..') {
    throw new Error(`[ENTROPY_GATE] cache key must be a single path segment: ${key}`);
  }
  const safeCacheDir = assertSafeRepositoryPath(CACHE_DIR, { allowMissingLeaf: true });
  if (safeExistsSync(safeCacheDir) && !safeLstat(safeCacheDir).isDirectory()) {
    throw new Error(`[ENTROPY_GATE] cache directory must be a directory: ${CACHE_DIR}`);
  }
  const hashPath = assertSafeRepositoryPath(path.join(safeCacheDir, `${key}.hash`), {
    allowMissingLeaf: true,
  });
  if (safeExistsSync(hashPath) && !safeLstat(hashPath).isFile()) {
    throw new Error(`[ENTROPY_GATE] cache hash must be a regular file: ${hashPath}`);
  }
  return hashPath;
}

/**
 * Entropy Gate v1.0
 * Allows the agent to detect if the environment has changed.
 */
export const entropyGate = {
  /**
   * Compare the given data with its last seen state.
   * If identical, returns false (Gate Closed - Sleep).
   * If changed, updates cache and returns true (Gate Open - Process).
   */
  shouldWake(key: string, data: any): boolean {
    const hashPath = safeHashPath(key);
    const safeCacheDir = assertSafeRepositoryPath(CACHE_DIR, { allowMissingLeaf: true });
    if (!safeExistsSync(safeCacheDir)) {
      safeMkdir(safeCacheDir, { recursive: true });
    }

    const currentData = typeof data === 'string' ? data : JSON.stringify(data);
    const currentHash = createHash('md5').update(currentData).digest('hex');

    if (safeExistsSync(hashPath)) {
      const lastHash = safeReadFile(hashPath, { encoding: 'utf8' }) as string;
      if (lastHash === currentHash) {
        return false; // No change, stay in sleep
      }
    }

    // Environmental change detected
    safeWriteFile(hashPath, currentHash);
    return true;
  },

  /**
   * Reset the gate for a specific key.
   */
  reset(key: string): void {
    const hashPath = safeHashPath(key);
    if (safeExistsSync(hashPath)) safeUnlinkSync(hashPath);
  },
};
