import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeLstat, safeReaddir, safeRealpath, assertSafeRepositoryPath } from '../secure-io.js';
import { classifyStorageFloorPath } from '../storage-layout.js';

const MAX_AUTH_HOME_ENTRIES = 2048;
const MAX_AUTH_HOME_DEPTH = 12;
const denied = () =>
  new Error(
    '[CREDENTIAL_HOME_INVALID] Expected a private tenant floor without links or special files'
  );

/** Rechecked immediately before each provider spawn. Reads metadata only, never credential contents. */
export function assertIsolatedProviderHome(env: NodeJS.ProcessEnv, tenantSlug: string): void {
  const home = env.HOME;
  if (!home || !path.isAbsolute(home)) throw denied();
  const root = pathResolver.rootDir();
  const relative = path.relative(root, home);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw denied();
  const floor = classifyStorageFloorPath(home);
  if (
    !floor ||
    floor.partition.kind !== 'tier' ||
    floor.partition.tenant !== tenantSlug ||
    floor.partition.tier === 'public' ||
    !['scratch', 'cache'].includes(floor.floor)
  )
    throw denied();
  try {
    const homeStat = safeLstat(assertSafeRepositoryPath(home));
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw denied();
    // Canonical equality rejects links in any ancestor without listing tenant-parent directories.
    const canonical = safeRealpath(home);
    if (canonical !== path.join(safeRealpath(root), relative)) throw denied();
    let visited = 0;
    const walk = (directory: string, depth: number) => {
      if (depth > MAX_AUTH_HOME_DEPTH) throw denied();
      for (const name of safeReaddir(directory)) {
        if (++visited > MAX_AUTH_HOME_ENTRIES) throw denied();
        const entry = path.join(directory, name);
        const stat = safeLstat(entry);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
          throw denied();
        if (stat.isDirectory()) walk(entry, depth + 1);
      }
    };
    walk(home, 0);
    for (const [key, value] of Object.entries(env)) {
      if (!value || key === 'HOME' || !/(?:_HOME|CONFIG_DIR|APPLICATION_CREDENTIALS)$/.test(key))
        continue;
      const below = path.relative(home, value);
      if (
        !path.isAbsolute(value) ||
        below === '..' ||
        below.startsWith('..' + path.sep) ||
        path.isAbsolute(below)
      )
        throw denied();
      // Config paths not created yet remain inside the already-vetted HOME; every existing ancestor was walked.
    }
  } catch {
    throw denied();
  }
}
