import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync } from './secure-io.js';
import {
  mountToVault,
  unmountFromVault,
  listVaultMounts,
  isAllowedVaultMountPath,
  getVaultMountsDir,
} from './vault-mount.js';

describe('vault-mount', () => {
  const mountsDir = getVaultMountsDir();

  it('rejects non-existent source paths', () => {
    expect(() => mountToVault('/non/existent/path/for/test/xyz')).toThrow(
      /Source path does not exist/
    );
  });

  it('mounts an existing directory and lists it', () => {
    // Mount a known directory (e.g. package.json or node_modules or a temp fixture)
    const testDir = path.resolve('node_modules');
    if (!safeExistsSync(testDir)) return;

    const mountName = 'test-node-modules-mount';
    try {
      const entry = mountToVault(testDir, mountName);
      expect(entry.name).toBe(mountName);
      expect(entry.targetPath).toBe(testDir);
      expect(safeExistsSync(entry.mountPath)).toBe(true);

      const mounts = listVaultMounts();
      const found = mounts.find((m) => m.name === mountName);
      expect(found).toBeDefined();
      expect(found?.targetPath).toBe(testDir);

      // Check isAllowedVaultMountPath
      expect(isAllowedVaultMountPath(path.join(testDir, 'vitest'))).toBe(true);
      expect(isAllowedVaultMountPath(path.join(mountsDir, mountName, 'vitest'))).toBe(true);
    } finally {
      unmountFromVault(mountName);
    }

    const afterUnmount = listVaultMounts();
    expect(afterUnmount.find((m) => m.name === mountName)).toBeUndefined();
  });
});
