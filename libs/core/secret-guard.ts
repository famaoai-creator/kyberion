import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Sovereign Secret Guard v1.3 [PERSONAL-SYNC Edition]
 * Implements Personal Knowledge Connection Mapping.
 */

const SECRETS_FILE = path.join(process.cwd(), 'vault/secrets/secrets.json');
const PERSONAL_CONNECTIONS_DIR = path.join(process.cwd(), 'knowledge/personal/connections');
const GRANTS_FILE = path.join(process.cwd(), 'active/shared/auth-grants.json');
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
  if (!fs.existsSync(PERSONAL_CONNECTIONS_DIR)) return;
  
  try {
    const items = fs.readdirSync(PERSONAL_CONNECTIONS_DIR);
    for (const item of items) {
      const fullPath = path.join(PERSONAL_CONNECTIONS_DIR, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Deep scan for services in directories (e.g., slack/slack-credentials.json)
        const serviceName = item.toUpperCase();
        const subFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.json'));
        for (const subFile of subFiles) {
          const content = JSON.parse(fs.readFileSync(path.join(fullPath, subFile), 'utf8'));
          _mapContentToSecrets(serviceName, content);
        }
      } else if (item.endsWith('.json')) {
        // Flat scan (e.g., slack.json)
        const serviceName = path.basename(item, '.json').toUpperCase();
        const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        _mapContentToSecrets(serviceName, content);
      }
    }
  } catch (_) {
    // Fail silently to maintain security/stability
  }
};

const _mapContentToSecrets = (serviceName: string, content: any) => {
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string') {
      const secretKey = `${serviceName}_${key.toUpperCase()}`;
      _cachedPersonalSecrets.set(secretKey, value);
    } else if (typeof value === 'object' && value !== null) {
      // Handle nested structures if necessary
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

  // TIBA GATE: If scope is provided, verify active grant from disk
  if (scope) {
    const grants = _loadGrants(); // Always reload from disk for multi-process sync
    const activeGrant = grants.find(g => 
      g.missionId === currentMission && 
      g.serviceId.toLowerCase() === scope.toLowerCase() && 
      g.expiresAt > Date.now()
    );

    if (!activeGrant) {
      // Fallback: Check if we are in a privileged system mission
      if (currentMission !== 'MSN-SYSTEM-NEXUS-DISPATCH') {
        throw new Error(`TIBA_VIOLATION: No active temporal grant for service "${scope}" in mission "${currentMission}". Access Denied.`);
      }
    }
  }

  // Basic Shield Violation Check (prefix match)
  if (scope && !key.toUpperCase().startsWith(scope.toUpperCase())) {
    throw new Error(`SHIELD_VIOLATION: Key "${key}" does not match authorized scope "${scope}".`);
  }

  // Priority 1: Environment Variables
  let value = process.env[key];

  // Priority 2: Personal Knowledge (Connections)
  if (!value) {
    value = _cachedPersonalSecrets.get(key);
  }

  // Priority 3: Vault Secrets
  if (!value && fs.existsSync(SECRETS_FILE)) {
    try {
      const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
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
  if (!fs.existsSync(GRANTS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8'));
  } catch (_) { return []; }
}

function _saveGrants(grants: AuthGrant[]) {
  const dir = path.dirname(GRANTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Prune expired grants before saving
  const freshGrants = grants.filter(g => g.expiresAt > Date.now());

  const tempPath = `${GRANTS_FILE}.tmp.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(freshGrants, null, 2), 'utf8');
  const fd = fs.openSync(tempPath, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tempPath, GRANTS_FILE);
}

export const getActiveSecrets = () => Array.from(_activeSecrets);
export const secretGuard = { getSecret, getActiveSecrets, grantAccess };
