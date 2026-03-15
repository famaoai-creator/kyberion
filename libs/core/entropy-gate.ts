import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { safeExistsSync, safeMkdir, safeReadFile, safeUnlinkSync, safeWriteFile } from './secure-io.js';

const CACHE_DIR = path.join(process.cwd(), 'active/shared/entropy-cache');

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
    if (!safeExistsSync(CACHE_DIR)) {
      safeMkdir(CACHE_DIR, { recursive: true });
    }

    const hashPath = path.join(CACHE_DIR, `${key}.hash`);
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
    const hashPath = path.join(CACHE_DIR, `${key}.hash`);
    if (safeExistsSync(hashPath)) safeUnlinkSync(hashPath);
  }
};
