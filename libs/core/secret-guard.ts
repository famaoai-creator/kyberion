import { 
  safeReadFile, 
  safeWriteFile, 
  safeReaddir, 
  safeStat, 
  logger 
} from './index.js';
import * as pathResolver from './path-resolver.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Sovereign Secret Guard v1.4 [STANDARDIZED]
 * Implements Personal Knowledge Connection Mapping with Secure-IO.
 */

const SECRETS_FILE = pathResolver.resolve('vault/secrets/secrets.json');
const PERSONAL_CONNECTIONS_DIR = pathResolver.resolve('knowledge/personal/connections');
const GRANTS_FILE = pathResolver.resolve('active/shared/auth-grants.json');
const _activeSecrets = new Set<string>();
const _cachedPersonalSecrets = new Map<string, string>();

interface AuthGrant {
  missionId: string;
  serviceId: string;
  expiresAt: number; // Timestamp
}

/**
 * Loads and maps secrets from personal connection files.
 * Handles both connections/*.json and connections/service/*.json
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
  } catch (_) {
    // Fail silently during boot
  }
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

// Initial load
_loadPersonalSecrets();

/**
 * Issued by Orchestrator to authorize a secret for a limited time.
 */
export const grantAccess = (missionId: string, serviceId: string, ttlMinutes = 15): void => {
  const grants = _loadGrants();
  grants.push({
    missionId,
    serviceId: serviceId.toLowerCase(),
    expiresAt: Date.now() + (ttlMinutes * 60 * 1000)
  });
  _saveGrants(grants);
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
      g.serviceId.toLowerCase() === scope.toLowerCase() && 
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

  if (!value) {
    value = _cachedPersonalSecrets.get(key);
  }

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
  try {
    const content = safeReadFile(GRANTS_FILE, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  } catch (_) { return []; }
}

function _saveGrants(grants: AuthGrant[]) {
  // Prune expired grants before saving
  const freshGrants = grants.filter(g => g.expiresAt > Date.now());
  const content = JSON.stringify(freshGrants, null, 2);
  
  // Use safeWriteFile which handles directories and basic safety
  safeWriteFile(GRANTS_FILE, content);
  
  // For physical sync assurance in multi-process (legacy necessity)
  try {
    const fd = fs.openSync(GRANTS_FILE, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (_) {}
}

export const getActiveSecrets = () => Array.from(_activeSecrets);
export const secretGuard = { getSecret, getActiveSecrets, grantAccess };
