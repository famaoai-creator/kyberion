import { 
  safeReadFile, 
  safeWriteFile, 
  safeReaddir, 
  safeStat,
  safeFsyncFile,
  safeExistsSync
} from './secure-io.js';
import { logger } from './core.js';
import { ledger } from './ledger.js';
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

const _clearServiceSecrets = (serviceName: string) => {
  const prefix = `${serviceName.toUpperCase()}_`;
  for (const key of Array.from(_cachedPersonalSecrets.keys())) {
    if (key.startsWith(prefix)) {
      _cachedPersonalSecrets.delete(key);
    }
  }
};

function _sanitizeServiceId(serviceId: string): string {
  return serviceId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function _connectionPath(serviceId: string): string {
  return path.join(PERSONAL_CONNECTIONS_DIR, `${_sanitizeServiceId(serviceId)}.json`);
}

function _loadConnectionDocument(serviceId: string): Record<string, any> {
  const fullPath = _connectionPath(serviceId);
  if (!safeExistsSync(fullPath)) return {};
  try {
    return JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string);
  } catch (_) {
    return {};
  }
}

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
  const authorizedScope = process.env.AUTHORIZED_SCOPE;

  if (scope) {
    // 1. Check Scoped Identity (For Daemons/Surfaces)
    const hasScopeIdentity = authorizedScope?.toLowerCase() === scope.toLowerCase();

    // 2. Check Temporal Mission Grants (For dynamic tasks)
    const grants = _loadGrants(); 
    const activeGrant = grants.find(g => 
      g.missionId === currentMission && 
      g.serviceId?.toLowerCase() === scope.toLowerCase() && 
      g.expiresAt > Date.now()
    );

    if (!activeGrant && !hasScopeIdentity) {
      throw new Error(`TIBA_VIOLATION: No active temporal grant or authorized scope for service "${scope}". Access Denied.`);
    }
  }

  if (scope && !key.toUpperCase().startsWith(scope.toUpperCase() + '_')) {
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

export const loadConnectionDocument = (serviceId: string): Record<string, any> => {
  return _loadConnectionDocument(serviceId);
};

export const storeConnectionDocument = (
  serviceId: string,
  patch: Record<string, any>,
  options: { backup?: boolean; missionId?: string; actor?: string } = {},
): { path: string; changedKeys: string[] } => {
  const fullPath = _connectionPath(serviceId);
  const existing = _loadConnectionDocument(serviceId);
  const next = { ...existing, ...patch };

  if (safeExistsSync(fullPath) && options.backup !== false) {
    const backupPath = `${fullPath}.bak`;
    safeWriteFile(backupPath, JSON.stringify(existing, null, 2) + '\n');
    try { safeFsyncFile(backupPath); } catch (_) {}
  }

  safeWriteFile(fullPath, JSON.stringify(next, null, 2) + '\n');
  try { safeFsyncFile(fullPath); } catch (_) {}

  const serviceName = _sanitizeServiceId(serviceId).toUpperCase();
  _clearServiceSecrets(serviceName);
  _mapContentToSecrets(serviceName, next);

  ledger.record('CONFIG_CHANGE', {
    mission_id: options.missionId || process.env.MISSION_ID || 'None',
    role: options.actor || process.env.MISSION_ROLE || 'secret_guard',
    config_target: path.relative(pathResolver.rootDir(), fullPath),
    config_scope: 'connection',
    service_id: serviceId,
    changed_keys: Object.keys(patch).sort(),
  });

  return {
    path: fullPath,
    changedKeys: Object.keys(patch).sort(),
  };
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

export const secretGuard = {
  getSecret,
  getActiveSecrets,
  grantAccess,
  checkAuthority,
  isSecretPath,
  loadConnectionDocument,
  storeConnectionDocument,
};
