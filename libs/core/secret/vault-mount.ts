/**
 * The Vault Mount (Vector 4: Ingestion Protocol)
 *
 * Connects host directories/files to vault/mounts/ via governed symlinks.
 * Complies with knowledge/product/orchestration/data-ingestion-protocol.md
 */

import * as path from 'node:path';
import { assertSensitivePathAllowed } from '../sensitive-path-policy.js';
import { pathResolver } from '../path-resolver.js';
import {
  rawExistsSync,
  rawLstatSync,
  rawMkdirp,
  rawReaddir,
  rawReadlinkSync,
  rawStatSync,
  rawSymlinkSync,
  rawUnlinkSync,
} from '../fs-primitives.js';

export interface VaultMountEntry {
  name: string;
  mountPath: string; // Absolute path inside vault/mounts/
  targetPath: string; // Real target path on host
  isDir: boolean;
  status: 'active' | 'broken';
}

function projectRoot(): string {
  return pathResolver.rootDir();
}

export function getVaultMountsDir(): string {
  return path.join(projectRoot(), 'vault', 'mounts');
}

/**
 * List all vault mounts, flagging broken links if target no longer exists.
 */
export function listVaultMounts(): VaultMountEntry[] {
  const mountsDir = getVaultMountsDir();
  if (!rawExistsSync(mountsDir)) return [];

  const entries: VaultMountEntry[] = [];
  try {
    const items = rawReaddir(mountsDir);
    for (const item of items) {
      if (item === '.gitkeep' || item.startsWith('.')) continue;
      const mountPath = path.join(mountsDir, item);
      try {
        const stat = rawLstatSync(mountPath);
        if (stat.isSymbolicLink()) {
          const target = rawReadlinkSync(mountPath);
          const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(mountsDir, target);

          let isDir = false;
          let isTargetAlive = false;
          try {
            const targetStat = rawStatSync(resolvedTarget);
            isDir = targetStat.isDirectory();
            isTargetAlive = true;
          } catch {
            // target does not exist or broken link
          }

          entries.push({
            name: item,
            mountPath,
            targetPath: resolvedTarget,
            isDir,
            status: isTargetAlive ? 'active' : 'broken',
          });
        }
      } catch {
        // ignore single entry error
      }
    }
  } catch {
    // ignore
  }

  return entries;
}

/**
 * Cleanup any broken symlinks inside vault/mounts/.
 * Returns list of removed mount names.
 */
export function cleanupVaultMounts(): string[] {
  const mounts = listVaultMounts();
  const removed: string[] = [];
  for (const mount of mounts) {
    if (mount.status === 'broken') {
      try {
        rawUnlinkSync(mount.mountPath);
        removed.push(mount.name);
      } catch {
        // ignore single removal error
      }
    }
  }
  return removed;
}

/**
 * Check if an absolute path is covered by an active vault mount.
 */
export function isAllowedVaultMountPath(targetPath: string): boolean {
  if (!targetPath) return false;
  const normalizedTarget = path.resolve(targetPath);

  // If path is directly inside vault/mounts/
  const mountsDir = getVaultMountsDir();
  const relToMounts = path.relative(mountsDir, normalizedTarget);
  if (
    relToMounts &&
    !relToMounts.startsWith('..') &&
    !path.isAbsolute(relToMounts) &&
    relToMounts !== '.gitkeep'
  ) {
    return true;
  }

  // Check against targets of all active mounts
  const mounts = listVaultMounts();
  for (const mount of mounts) {
    const rel = path.relative(mount.targetPath, normalizedTarget);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }

  return false;
}

/**
 * Mount a host path into vault/mounts/<name>.
 */
export function mountToVault(sourcePath: string, customName?: string): VaultMountEntry {
  const resolvedSource = path.resolve(
    sourcePath.startsWith('~') ? path.join(process.env.HOME || '', sourcePath.slice(1)) : sourcePath
  );

  if (!rawExistsSync(resolvedSource)) {
    throw new Error(`[VAULT_MOUNT] Source path does not exist: ${resolvedSource}`);
  }

  // Deny mounting sensitive paths (SSH, AWS keys, etc.)
  assertSensitivePathAllowed(resolvedSource, 'read');

  const baseName = customName || path.basename(resolvedSource);
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safeName) {
    throw new Error(`[VAULT_MOUNT] Invalid mount name derived from: ${sourcePath}`);
  }

  const mountsDir = getVaultMountsDir();
  if (!rawExistsSync(mountsDir)) {
    rawMkdirp(mountsDir);
  }

  const mountPath = path.join(mountsDir, safeName);
  if (rawExistsSync(mountPath) || rawLstatSyncSafe(mountPath)) {
    // If it's already a symlink pointing to the same target, reuse it
    try {
      if (rawLstatSync(mountPath).isSymbolicLink()) {
        const currentTarget = path.resolve(mountsDir, rawReadlinkSync(mountPath));
        if (currentTarget === resolvedSource) {
          return {
            name: safeName,
            mountPath,
            targetPath: resolvedSource,
            isDir: rawStatSync(resolvedSource).isDirectory(),
            status: 'active',
          };
        }
      }
    } catch {
      // ignore
    }
    throw new Error(
      `[VAULT_MOUNT] Mount destination already exists: ${mountPath}. Unmount it first.`
    );
  }

  // Create symlink
  rawSymlinkSync(resolvedSource, mountPath);

  return {
    name: safeName,
    mountPath,
    targetPath: resolvedSource,
    isDir: rawStatSync(resolvedSource).isDirectory(),
    status: 'active',
  };
}

/**
 * Unmount (remove symlink) from vault/mounts/<name>.
 */
export function unmountFromVault(name: string): boolean {
  const mountsDir = getVaultMountsDir();
  const mountPath = path.join(mountsDir, name);

  if (!rawLstatSyncSafe(mountPath)) {
    return false;
  }

  const stat = rawLstatSync(mountPath);
  if (!stat.isSymbolicLink()) {
    throw new Error(`[VAULT_MOUNT] Refusing to remove non-symlink at: ${mountPath}`);
  }

  rawUnlinkSync(mountPath);
  return true;
}

function rawLstatSyncSafe(filePath: string): boolean {
  try {
    return Boolean(rawLstatSync(filePath));
  } catch {
    return false;
  }
}
