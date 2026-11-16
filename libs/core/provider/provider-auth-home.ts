import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeLstat, safeReaddir, safeRealpath, assertSafeRepositoryPath } from '../secure-io.js';
import {
  classifyStorageFloorPath,
  storageFloorRelativePath,
  type StorageDataTier,
} from '../storage-layout.js';

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

/** Short stable hash naming one credential's provider-auth directory (never the value). */
export function credentialRefHash(credentialRef: string): string {
  return createHash('sha256').update(credentialRef).digest('hex').slice(0, 16);
}

/**
 * Repo-relative isolated HOME of one provider for one borrower and one
 * credential: `active/shared/cache/<tier>/<borrower>/provider-auth/<provider>/<hash>/home`.
 * The cache floor of the borrower's non-public tier.
 */
export function providerAuthHomeRelativePath(
  tier: StorageDataTier,
  borrowerTenant: string,
  provider: string,
  credentialRef: string
): string {
  if (tier === 'public')
    throw new Error('[CREDENTIAL_HOME_INVALID] Provider auth never lives on the public tier');
  return storageFloorRelativePath(
    'cache',
    { kind: 'tier', tier, tenant: borrowerTenant },
    'provider-auth',
    provider,
    credentialRefHash(credentialRef),
    'home'
  );
}
