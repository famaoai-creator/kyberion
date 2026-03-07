import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Sovereign Secret Guard v1.2 [TIBA COMPLIANT]
 * Implements Temporal Intent-Based Authentication.
 */

const SECRETS_FILE = path.join(process.cwd(), 'vault/secrets/secrets.json');
const GRANTS_FILE = path.join(process.cwd(), 'active/shared/auth-grants.json');
const _activeSecrets = new Set<string>();

interface AuthGrant {
  missionId: string;
  serviceId: string;
  expiresAt: number; // Timestamp
}

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

  // TIBA GATE: If scope is provided, verify active grant
  if (scope) {
    const grants = _loadGrants();
    const activeGrant = grants.find(g => 
      g.missionId === currentMission && 
      g.serviceId === scope.toLowerCase() && 
      g.expiresAt > Date.now()
    );

    if (!activeGrant) {
      throw new Error(`TIBA_VIOLATION: No active temporal grant for service "${scope}" in mission "${currentMission}". Access Denied.`);
    }
  }

  // Basic Shield Violation Check (prefix match)
  if (scope && !key.toUpperCase().startsWith(scope.toUpperCase())) {
    throw new Error(`SHIELD_VIOLATION: Key "${key}" does not match authorized scope "${scope}".`);
  }

  let value = process.env[key];
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
  fs.writeFileSync(GRANTS_FILE, JSON.stringify(freshGrants, null, 2));
}

export const getActiveSecrets = () => Array.from(_activeSecrets);
export const secretGuard = { getSecret, getActiveSecrets, grantAccess };
