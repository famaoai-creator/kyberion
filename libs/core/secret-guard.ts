import * as secureIo from './secure-io.js';
import { logger } from './core.js';
import { ledger } from './ledger.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import { resolveSecretSync } from './secret-resolver.js';
import {
  decryptConnectionDocument,
  encryptConnectionDocument,
  isEncryptedConnectionEnvelope,
  resolveSecretEncryptionMode,
} from './secret-encryption.js';

/**
 * Sovereign Secret Guard v1.5 [AUTHORITY ENABLED]
 * Implements Personal Knowledge Connection Mapping with Secure-IO and Temporal Authority.
 */

const SECRETS_FILE = pathResolver.resolve('vault/secrets/secrets.json');
const PERSONAL_CONNECTIONS_DIR = pathResolver.resolve('knowledge/personal/connections');
const GRANTS_FILE = pathResolver.resolve('active/shared/auth-grants.json');
const _activeSecrets = new Set<string>();
const _cachedPersonalSecrets = new Map<string, string>();
// Keep these as lazy wrappers: secure-io and audit-chain have a pre-existing
// import cycle, so the mediation function cannot be invoked during module load.
const safeReadFile = (...args: Parameters<typeof secureIo.safeReadFile>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeReadFile(...args));
const safeWriteFile = (...args: Parameters<typeof secureIo.safeWriteFile>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeWriteFile(...args));
const safeReaddir = (...args: Parameters<typeof secureIo.safeReaddir>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeReaddir(...args));
const safeStat = (...args: Parameters<typeof secureIo.safeStat>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeStat(...args));
const safeFsyncFile = (...args: Parameters<typeof secureIo.safeFsyncFile>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeFsyncFile(...args));
const safeExistsSync = (...args: Parameters<typeof secureIo.safeExistsSync>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeExistsSync(...args));

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
        const subFiles = safeReaddir(fullPath).filter((f) => f.endsWith('.json'));
        for (const subFile of subFiles) {
          const content = JSON.parse(
            safeReadFile(path.join(fullPath, subFile), { encoding: 'utf8' }) as string
          );
          _mapContentToSecrets(serviceName, content);
        }
      } else if (item.endsWith('.json')) {
        const serviceName = path.basename(item, '.json').toUpperCase();
        let content = JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string);
        if (isEncryptedConnectionEnvelope(content)) {
          // Startup scan runs at module import — an undecryptable file must
          // degrade to a warning here, not crash every importer.
          try {
            content = decryptConnectionDocument(content);
          } catch (err) {
            logger.warn(`[secret-guard] cannot decrypt ${item} during startup scan: ${err}`);
            continue;
          }
        }
        _mapContentToSecrets(serviceName, content);
      }
    }
  } catch (_) {
    /* startup scan is best-effort; missing/corrupt docs are skipped */
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string);
  } catch (_) {
    return {};
  }
  // AC-05: auto-detect the at-rest format. An encrypted document that cannot
  // be decrypted must fail loudly — the data exists, silently returning {}
  // would look like a wiped connection.
  if (isEncryptedConnectionEnvelope(parsed)) {
    return decryptConnectionDocument(parsed) as Record<string, any>;
  }
  return parsed as Record<string, any>;
}

_loadPersonalSecrets();

/**
 * Issued by Orchestrator to authorize a secret or authority for a limited time.
 *
 * Use `grantAccessGuarded` instead for operations that must pass through
 * the approval gate (e.g. SUDO authority grants, long-TTL grants).
 */
export const grantAccess = (
  missionId: string,
  serviceIdOrAuth: string,
  ttlMinutes = 15,
  isAuthority = false
): void => {
  const grants = _loadGrants();
  const grant: AuthGrant = {
    missionId,
    expiresAt: Date.now() + ttlMinutes * 60 * 1000,
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
 * Grant access gated through the approval gate. Throws if the approval
 * gate denies the request (no approval found or pending).
 *
 * Intended for high-risk grants such as:
 *   - Authority grants (isAuthority=true, especially SUDO)
 *   - Long-TTL service grants (> 60 min)
 *
 * The normal `grantAccess` path remains available for low-risk,
 * short-TTL, pre-approved service grants.
 */
export const grantAccessGuarded = async (
  missionId: string,
  serviceIdOrAuth: string,
  ttlMinutes = 15,
  isAuthority = false,
  options: {
    agentId?: string;
    correlationId?: string;
    channel?: string;
  } = {}
): Promise<void> => {
  // Dynamic import to avoid circular dependency between secret-guard and
  // risky-op-registry/approval-gate (which imports governance readers that
  // indirectly import secret-guard).
  const [{ requireApprovalForOp, RISKY_OPS }] = await Promise.all([
    import('./risky-op-registry.js'),
  ]);

  const opId = isAuthority ? RISKY_OPS.AUTH_GRANT_AUTHORITY : RISKY_OPS.SECRET_GRANT_ACCESS;
  const decision = requireApprovalForOp({
    opId,
    agentId: options.agentId ?? 'mission_controller',
    correlationId: options.correlationId ?? `${missionId}:${serviceIdOrAuth}`,
    channel: options.channel ?? 'system',
    payload: {
      missionId,
      target: serviceIdOrAuth,
      ttlMinutes,
      isAuthority,
    },
    draft: {
      title: `${isAuthority ? 'Authority' : 'Service'} grant requested: ${serviceIdOrAuth}`,
      summary: `Mission ${missionId} requests ${isAuthority ? 'authority' : 'service'} "${serviceIdOrAuth}" for ${ttlMinutes} minutes.`,
      severity: isAuthority ? 'high' : 'medium',
    },
  });

  if (!decision.allowed) {
    throw new Error(
      `[secret-guard] grantAccess blocked by approval gate for ${missionId}:${serviceIdOrAuth} — ${decision.message ?? decision.status}`
    );
  }

  grantAccess(missionId, serviceIdOrAuth, ttlMinutes, isAuthority);
};

/**
 * Checks if a specific authority is granted to a mission.
 */
export const checkAuthority = (missionId: string, authority: string): boolean => {
  const grants = _loadGrants();
  return grants.some(
    (g) => g.missionId === missionId && g.authority === authority && g.expiresAt > Date.now()
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
    const activeGrant = grants.find(
      (g) =>
        g.missionId === currentMission &&
        g.serviceId?.toLowerCase() === scope.toLowerCase() &&
        g.expiresAt > Date.now()
    );

    if (!activeGrant && !hasScopeIdentity) {
      throw new Error(
        `TIBA_VIOLATION: No active temporal grant or authorized scope for service "${scope}". Access Denied.`
      );
    }
  }

  if (scope && !key.toUpperCase().startsWith(scope.toUpperCase() + '_')) {
    throw new Error(`SHIELD_VIOLATION: Key "${key}" does not match authorized scope "${scope}".`);
  }

  // 0. Upstream resolver (external KMS — AWS Secrets Manager, Vault, etc.)
  //    consulted first if one is registered. Returns null on miss; missing
  //    resolver falls through to the local vault chain below.
  const upstream = resolveSecretSync({ key, scope });
  if (upstream && upstream.length > 0) {
    if (upstream.length > 8) _activeSecrets.add(upstream);
    return upstream;
  }

  let value = process.env[key];
  if (!value) value = _cachedPersonalSecrets.get(key);
  if (!value) {
    try {
      const secrets = JSON.parse(safeReadFile(SECRETS_FILE, { encoding: 'utf8' }) as string);
      value = secrets[key];
    } catch (_) {
      /* secrets file absent or corrupt: fall back to env-only resolution */
    }
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
  options: { backup?: boolean; missionId?: string; actor?: string } = {}
): { path: string; changedKeys: string[] } => {
  const fullPath = _connectionPath(serviceId);
  const existing = _loadConnectionDocument(serviceId);
  const next = { ...existing, ...patch };

  if (safeExistsSync(fullPath) && options.backup !== false) {
    // Back up the raw previous bytes: an encrypted document must never gain
    // a plaintext .bak sibling.
    const backupPath = `${fullPath}.bak`;
    safeWriteFile(backupPath, safeReadFile(fullPath, { encoding: 'utf8' }) as string);
    try {
      safeFsyncFile(backupPath);
    } catch (_) {
      /* best-effort fsync */
    }
  }

  const serialized =
    resolveSecretEncryptionMode() === 'none'
      ? JSON.stringify(next, null, 2)
      : JSON.stringify(encryptConnectionDocument(next), null, 2);
  safeWriteFile(fullPath, serialized + '\n');
  try {
    safeFsyncFile(fullPath);
  } catch (_) {
    /* best-effort fsync */
  }

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
  } catch (_) {
    return [];
  }
}

function _saveGrants(grants: AuthGrant[]) {
  const freshGrants = grants.filter((g) => g.expiresAt > Date.now());
  safeWriteFile(GRANTS_FILE, JSON.stringify(freshGrants, null, 2));
  try {
    safeFsyncFile(GRANTS_FILE);
  } catch (_) {
    /* best-effort fsync */
  }
}

export const getActiveSecrets = () => Array.from(_activeSecrets);

export const isSecretPath = (filePath: string): boolean => {
  const resolved = path.resolve(filePath);
  return [
    SECRETS_FILE,
    PERSONAL_CONNECTIONS_DIR,
    GRANTS_FILE,
    pathResolver.resolve('vault/secrets/'),
    pathResolver.resolve('knowledge/personal/connections/'),
  ].some((p) => resolved.startsWith(p));
};

export const secretGuard = {
  getSecret,
  getActiveSecrets,
  grantAccess,
  grantAccessGuarded,
  checkAuthority,
  isSecretPath,
  loadConnectionDocument,
  storeConnectionDocument,
};
