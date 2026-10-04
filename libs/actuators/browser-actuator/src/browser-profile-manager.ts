import * as os from 'node:os';
import * as path from 'node:path';
import { assertSensitivePathAllowed } from '@agent/core/sensitive-path-policy';
import {
  safeExistsSync,
  safeReaddir,
  safeStat,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { readJsonIfPresent } from '@agent/core/foundation';

export type BrowserProvider = string;

export type BrowserProfileStatus = 'active' | 'idle' | 'locked';

export interface BrowserProfile {
  id: string; // Directory name (e.g. 'Default', 'Profile 1', 'agent-isolated')
  provider: BrowserProvider;
  name: string; // Display name (e.g. 'Motonobu', 'Work', 'default-playwright')
  email?: string; // Associated Google/user account email if available
  userDataDir: string; // Absolute path to the user data directory
  profileDirectory?: string; // Relative directory within userDataDir (for Chrome/Edge)
  status: BrowserProfileStatus;
  isDefault?: boolean;
  lastActiveTime?: number;
  metadata?: Record<string, unknown>;
}

export interface ProfileSearchQuery {
  provider?: BrowserProvider | 'all';
  profile?: string; // ID, name, or email to match
  id?: string;
  name?: string;
  email?: string;
}

/**
 * Returns the default Google Chrome user data directory based on current OS.
 */
export function getDefaultChromeUserDataDir(
  platform: string = process.platform,
  options: { ignoreVaultMount?: boolean } = {}
): string {
  // Prefer vault mount if active
  if (!options.ignoreVaultMount) {
    const vaultMountCandidate = pathResolver.vault('mounts/host-chrome');
    if (safeExistsSync(vaultMountCandidate)) {
      return vaultMountCandidate;
    }
  }

  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library/Application Support/Google/Chrome');
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  return path.join(home, '.config', 'google-chrome');
}

/**
 * Returns the default Playwright managed profiles directory under active/shared/.
 */
export function getDefaultPlaywrightProfilesDir(): string {
  return pathResolver.resolve('active/shared/browser_profiles');
}

/**
 * Check whether a Chrome profile is currently active or recently active.
 */
export function isChromeProfileActive(
  userDataDir: string,
  profileDirName: string,
  recentThresholdMs: number = 30 * 60 * 1000 // 30 minutes
): boolean {
  // Check 1: singleton lock in userDataDir (may be regular file or symlink)
  const lockFiles = ['SingletonLock', 'lockfile'];
  let isBrowserRunning = false;
  for (const lockFile of lockFiles) {
    const lockPath = path.join(userDataDir, lockFile);
    try {
      assertSensitivePathAllowed(lockPath, 'read');
      if (safeExistsSync(lockPath)) {
        isBrowserRunning = true;
        break;
      }
      const stat = safeLstat(lockPath);
      if (stat.isSymbolicLink()) {
        isBrowserRunning = true;
        break;
      }
    } catch {
      // not exists or not allowed
    }
  }

  // Check 2: DevToolsActivePort in userDataDir (indicates running instance with CDP)
  const devToolsPath = path.join(userDataDir, 'DevToolsActivePort');
  try {
    assertSensitivePathAllowed(devToolsPath, 'read');
    if (safeExistsSync(devToolsPath)) {
      isBrowserRunning = true;
    }
  } catch {
    // ignore
  }

  // Check 3: Check Session directory for active session files with recent mtime
  const sessionDir = path.join(userDataDir, profileDirName, 'Sessions');
  try {
    assertSensitivePathAllowed(sessionDir, 'read');
    if (safeExistsSync(sessionDir)) {
      const files = safeReaddir(sessionDir);
      const sessionFiles = files.filter((f) => f.startsWith('Session_'));
      const now = Date.now();
      for (const f of sessionFiles) {
        const filePath = path.join(sessionDir, f);
        const stat = safeStat(filePath);
        if (now - stat.mtimeMs < recentThresholdMs && isBrowserRunning) {
          return true;
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return false;
}

/**
 * Discover and parse Chrome profiles from Local State.
 */
export function listChromeProfiles(customUserDataDir?: string): BrowserProfile[] {
  const userDataDir = customUserDataDir || getDefaultChromeUserDataDir();
  const localStatePath = path.join(userDataDir, 'Local State');

  assertSensitivePathAllowed(localStatePath, 'read');
  if (!safeExistsSync(localStatePath)) {
    return [];
  }

  try {
    const localState = readJsonIfPresent<Record<string, any>>(localStatePath);
    const infoCache = localState?.profile?.info_cache;

    if (!infoCache || typeof infoCache !== 'object') {
      return [];
    }

    const profiles: BrowserProfile[] = [];

    for (const [profileDir, info] of Object.entries(infoCache) as [string, Record<string, any>][]) {
      const name = (info?.name as string) || profileDir;
      const email = (info?.user_name as string) || undefined;
      const isDefault = profileDir === 'Default';
      const active = isChromeProfileActive(userDataDir, profileDir);

      profiles.push({
        id: profileDir,
        provider: 'chrome',
        name,
        email,
        userDataDir,
        profileDirectory: profileDir,
        status: active ? 'active' : 'idle',
        isDefault,
        lastActiveTime: typeof info?.active_time === 'number' ? info.active_time : undefined,
        metadata: {
          avatar_icon: info?.avatar_icon,
          is_using_default_name: info?.is_using_default_name,
        },
      });
    }

    return profiles;
  } catch {
    return [];
  }
}

/**
 * Discover Playwright managed profiles.
 */
export function listPlaywrightProfiles(customBaseDir?: string): BrowserProfile[] {
  const baseDir = customBaseDir || getDefaultPlaywrightProfilesDir();
  assertSensitivePathAllowed(baseDir, 'read');
  if (!safeExistsSync(baseDir)) {
    return [];
  }

  try {
    const entries = safeReaddir(baseDir);
    const profiles: BrowserProfile[] = [];

    for (const entry of entries) {
      const profilePath = path.join(baseDir, entry);
      const manifestPath = path.join(profilePath, 'profile.json');
      const sessionPath = path.join(profilePath, 'session.json');

      assertSensitivePathAllowed(manifestPath, 'read');
      assertSensitivePathAllowed(sessionPath, 'read');

      let name = entry;
      let email: string | undefined;
      let metadata: Record<string, unknown> = {};

      const manifestData = readJsonIfPresent<Record<string, any>>(manifestPath);
      if (manifestData) {
        if (manifestData.name) name = manifestData.name;
        if (manifestData.email) email = manifestData.email;
        if (manifestData.metadata) metadata = manifestData.metadata;
        if (typeof manifestData.engine === 'string')
          metadata = { ...metadata, engine: manifestData.engine };
      }

      let status: BrowserProfileStatus = 'idle';
      const sessionData = readJsonIfPresent<Record<string, any>>(sessionPath);
      if (sessionData?.leaseExpiresAt && sessionData.leaseExpiresAt > Date.now()) {
        status = 'active';
      }

      profiles.push({
        id: entry,
        provider: 'playwright',
        name,
        email,
        userDataDir: profilePath,
        status,
        metadata,
      });
    }

    return profiles;
  } catch {
    return [];
  }
}

/**
 * Discover all profiles across supported browser providers.
 */
export function listBrowserProfiles(
  options: {
    provider?: BrowserProvider | 'all';
    customChromeDir?: string;
    customPlaywrightDir?: string;
  } = {}
): BrowserProfile[] {
  const targetProvider = options.provider || 'all';
  const profiles: BrowserProfile[] = [];

  if (targetProvider === 'all' || targetProvider === 'chrome') {
    profiles.push(...listChromeProfiles(options.customChromeDir));
  }

  if (targetProvider === 'all' || targetProvider === 'playwright') {
    profiles.push(...listPlaywrightProfiles(options.customPlaywrightDir));
  }

  return profiles;
}

/**
 * Resolve a profile query to a matching BrowserProfile.
 */
export function resolveBrowserProfile(
  query: ProfileSearchQuery | string,
  profiles?: BrowserProfile[]
): BrowserProfile | undefined {
  const search: ProfileSearchQuery = typeof query === 'string' ? { profile: query } : query;
  const available = profiles || listBrowserProfiles({ provider: search.provider });

  const term = (search.profile || search.id || search.name || search.email || '')
    .trim()
    .toLowerCase();
  if (!term) return undefined;

  // 1. Exact ID match (case-sensitive then insensitive)
  const exactId = available.find((p) => p.id === term || p.id.toLowerCase() === term);
  if (exactId) return exactId;

  // 2. Exact Name match (case-insensitive)
  const exactName = available.find((p) => p.name.toLowerCase() === term);
  if (exactName) return exactName;

  // 3. Exact Email match (case-insensitive)
  const exactEmail = available.find((p) => p.email && p.email.toLowerCase() === term);
  if (exactEmail) return exactEmail;

  // 4. Substring / Prefix match on Name or ID
  const partial = available.find(
    (p) => p.name.toLowerCase().includes(term) || p.id.toLowerCase().includes(term)
  );
  if (partial) return partial;

  return undefined;
}

/**
 * Create or initialize a new Playwright managed profile.
 */
export function createPlaywrightProfile(
  name: string,
  options: {
    id?: string;
    email?: string;
    engine?: 'chromium' | 'firefox' | 'webkit';
    metadata?: Record<string, unknown>;
  } = {}
): BrowserProfile {
  const safeId = (options.id || name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_');
  if (!safeId) {
    throw new Error(`[BROWSER_PROFILE] Invalid profile name/id: ${name}`);
  }

  const baseDir = getDefaultPlaywrightProfilesDir();
  const profileDir = path.join(baseDir, safeId);

  if (!safeExistsSync(profileDir)) {
    safeMkdir(profileDir);
  }

  const manifestPath = path.join(profileDir, 'profile.json');
  const manifestData = {
    id: safeId,
    name,
    email: options.email,
    engine: options.engine || 'chromium',
    createdAt: new Date().toISOString(),
    metadata: options.metadata || {},
  };

  safeWriteFile(manifestPath, JSON.stringify(manifestData, null, 2));

  return {
    id: safeId,
    provider: 'playwright',
    name,
    email: options.email,
    userDataDir: profileDir,
    status: 'idle',
    metadata: manifestData,
  };
}
