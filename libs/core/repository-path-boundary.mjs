import { existsSync, lstatSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Bootstrap-safe repository path validation shared with commands that must run
 * before the compiled core package is available. Keep this dependency-free so
 * path-resolver can enforce the boundary without importing secure-io.
 */
export function assertSafeRepositoryPath(
  filePath,
  { allowMissingLeaf = false, allowSymlinkLeaf = false, rootDir } = {}
) {
  if (!filePath) throw new Error('Missing required resource path');

  const root = path.resolve(rootDir ?? process.cwd());
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const relative = path.relative(root, resolved).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(
      `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${filePath}`
    );
  }

  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const isLeaf = current === resolved;
        if (allowSymlinkLeaf && isLeaf) continue;
        throw new Error(
          `[RESOURCE_PATH_SYMLINK] resource path cannot traverse a symbolic link: ${filePath}`
        );
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }

  if (!allowMissingLeaf && !existsSync(resolved)) {
    throw new Error(`Resource path does not exist: ${resolved}`);
  }
  return resolved;
}
