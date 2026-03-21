import { 
  safeReadFile, 
  safeWriteFile, 
  safeReaddir, 
  safeStat,
  safeFsyncFile,
  safeExistsSync
} from './secure-io.js';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';

/**
 * Sovereign Secret Guard v1.5 [AUTHORITY ENABLED]
 * Implements Personal Knowledge Connection Mapping with Secure-IO and Temporal Authority.
 */

const SECRETS_FILE = pathResolver.resolve('vault/secrets/secrets.json');
const PERSONAL_CONNECTIONS_DIR = pathResolver.resolve('knowledge/personal/connections');
const GRANTS_FILE = pathResolver.resolve('active/shared/auth-grants.json');
const _activeSecrets = new Set<string>();
const _cachedPersonalSecrets = new Map<string, string>();

interface AuthGrant {
  missionId: string;
  serviceId?: string;
  authority?: string;
  expiresAt: number; // Timestamp
}

/**
 * Loads and maps secrets from personal connection files.
 */
const _loadPersonalSecrets = () => {
  try {
    const items = safeReaddir(PERSONAL_CONNECTIONS_DIR);
    for (const item of items) {
      const fullPath = path.join(PERSONAL_CONNECTIONS_DIR, item);
      const stat = safeStat(fullPath);

      if (stat.isDirectory()) {
        const serviceName = item.toUpperCase();
        const subFiles = safeReaddir(fullPath).filter(f => f.endsWith('.json'));
        for (const subFile of subFiles) {
          const content = JSON.parse(safeReadFile(path.join(fullPath, subFile), { encoding: 'utf8' }) as string);
          _mapContentToSecrets(serviceName, content);
        }
      } else if (item.endsWith('.json')) {
        const serviceName = path.basename(item, '.json').toUpperCase();
        const content = JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string);
        _mapContentToSecrets(serviceName, content);
      }
    }
  } catch (_) {}
};

const _mapContentToSecrets = (serviceName: string, content: any) => {
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string') {
      const secretKey = `${serviceName}_${key.toUpperCase()}`;
      _cachedPersonalSecrets.set(secretKey, value);
    } else if (typeof value === 'object' && value !== null) {
      _mapContentToSecrets(serviceName, value);
    }
  }
};

_loadPersonalSecrets();

/**
 * Issued by Orchestrator to authorize a secret or authority for a limited time.
 */
export const grantAccess = (missionId: string, serviceIdOrAuth: string, ttlMinutes = 15, isAuthority = false): void => {
  const grants = _loadGrants();
  const grant: AuthGrant = {
    missionId,
    expiresAt: Date.now() + (ttlMinutes * 60 * 1000)
  };

  if (isAuthority) {
    grant.authority = serviceIdOrAuth;
  } else {
    grant.serviceId = serviceIdOrAuth.toLowerCase();
  }

  grants.push(grant);
  _saveGrants(grants);
};

/**
 * Checks if a specific authority is granted to a mission.
 */
export const checkAuthority = (missionId: string, authority: string): boolean => {
  const grants = _loadGrants();
  return grants.some(g => 
    g.missionId === missionId && 
    g.authority === authority && 
    g.expiresAt > Date.now()
  );
};

/**
 * Retrieve a secret value, enforcing temporal and intent-based gates.
 */
export const getSecret = (key: string, scope?: string): string | null => {
  const currentMission = process.env.MISSION_ID;

  if (scope) {
    const grants = _loadGrants(); 
    const isPrivileged = currentMission === 'MSN-SYSTEM-NEXUS-DISPATCH' || 
                        currentMission === 'MSN-SYSTEM-SENSORY-HUB';
    
    const activeGrant = grants.find(g => 
      g.missionId === currentMission && 
      g.serviceId?.toLowerCase() === scope.toLowerCase() && 
      g.expiresAt > Date.now()
    );

    if (!activeGrant && !isPrivileged) {
      throw new Error(`TIBA_VIOLATION: No active temporal grant for service "${scope}" in mission "${currentMission}". Access Denied.`);
    }
  }

  if (scope && !key.toUpperCase().startsWith(scope.toUpperCase())) {
    throw new Error(`SHIELD_VIOLATION: Key "${key}" does not match authorized scope "${scope}".`);
  }

  let value = process.env[key];
  if (!value) value = _cachedPersonalSecrets.get(key);
  if (!value) {
    try {
      const secrets = JSON.parse(safeReadFile(SECRETS_FILE, { encoding: 'utf8' }) as string);
      value = secrets[key];
    } catch (_) {}
  }

  if (value && typeof value === 'string') {
    if (value.length > 8) _activeSecrets.add(value);
    return value;
  }
  return null;
};

function _loadGrants(): AuthGrant[] {
  if (!safeExistsSync(GRANTS_FILE)) return [];
  try {
    const content = safeReadFile(GRANTS_FILE, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  } catch (_) { return []; }
}

function _saveGrants(grants: AuthGrant[]) {
  const freshGrants = grants.filter(g => g.expiresAt > Date.now());
  safeWriteFile(GRANTS_FILE, JSON.stringify(freshGrants, null, 2));
  try { safeFsyncFile(GRANTS_FILE); } catch (_) {}
}

export const getActiveSecrets = () => Array.from(_activeSecrets);

export const isSecretPath = (filePath: string): boolean => {
  const resolved = path.resolve(filePath);
  return [
    SECRETS_FILE,
    PERSONAL_CONNECTIONS_DIR,
    GRANTS_FILE,
    pathResolver.resolve('vault/secrets/'),
    pathResolver.resolve('knowledge/personal/connections/')
  ].some(p => resolved.startsWith(p));
};

export const secretGuard = { getSecret, getActiveSecrets, grantAccess, checkAuthority, isSecretPath };
