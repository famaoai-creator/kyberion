// Non-sensitive readiness is exposed through the public credential facade.
export {
  credentialBindingReadiness,
  isCredentialBindingRequired,
  type CredentialBindingReadiness,
} from '../foundation/credential-binding.js';
import * as secureIo from '../secure-io.js';
import { operatorProbeSecretAccess } from '../service/operator-service-connection-admission.js';
import { ledger } from '../governance/ledger.js';
import * as pathResolver from '../path-resolver.js';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { resolveSecretSync } from './secret-resolver.js';
import {
  resolveTaskCredential,
  credentialExecutionIdentity,
  isCurrentTaskCredentialValue,
} from '../foundation/credential-binding.js';
import {
  decryptConnectionDocument,
  encryptConnectionDocument,
  isEncryptedConnectionEnvelope,
  resolveSecretEncryptionMode,
} from './secret-encryption.js';
import { requireRiskyApproval } from '../governance/risky-op-approval-port.js';
import { RISKY_OPS } from '../contracts/risky-op-ids.js';
import { readJson, writeJson } from '../foundation/json.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import { withSecretResolutionSession } from '../foundation/secret-resolution-session.js';
import {
  assertPluginGrantAllows,
  findPluginGrantDenial,
  getPluginExecutionContext,
  PluginGrantDeniedError,
} from '../shell/sandbox-policy.js';

/**
 * Sovereign Secret Guard v1.5 [AUTHORITY ENABLED]
 * Implements Personal Knowledge Connection Mapping with Secure-IO and Temporal Authority.
 */

const requireSecretModules = createRequire(import.meta.url);

const SECRETS_FILE = pathResolver.resolve('vault/secrets/secrets.json');
const PERSONAL_CONNECTIONS_DIR = pathResolver.resolve('knowledge/personal/connections');
const GRANTS_FILE = pathResolver.resolve('active/shared/auth-grants.json');
const _activeSecrets = new Set<string>();
// Active secret value -> the secret names it was resolved under (plugin masking scope).
const _activeSecretNames = new Map<string, Set<string>>();
const _rememberActiveSecret = (key: string, value: string): void => {
  _activeSecrets.add(value);
  const names = _activeSecretNames.get(value) ?? new Set<string>();
  names.add(key);
  _activeSecretNames.set(value, names);
};
const _cachedPersonalSecrets = new Map<string, string>();
// Keep these as lazy wrappers: secure-io and audit-chain have a pre-existing
// import cycle, so the mediation function cannot be invoked during module load.
const safeReadFile = (...args: Parameters<typeof secureIo.safeReadFile>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeReadFile(...args));
const safeWriteFile = (...args: Parameters<typeof secureIo.safeWriteFile>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeWriteFile(...args));
const readSensitiveJson = <T>(filePath: string): T =>
  secureIo.withSensitivePathMediation(() => readJson<T>(filePath));
const safeReaddir = (...args: Parameters<typeof secureIo.safeReaddir>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeReaddir(...args));
const safeLstat = (...args: Parameters<typeof secureIo.safeLstat>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeLstat(...args));
const safeFsyncFile = (...args: Parameters<typeof secureIo.safeFsyncFile>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeFsyncFile(...args));
const safeExistsSync = (...args: Parameters<typeof secureIo.safeExistsSync>) =>
  secureIo.withSensitivePathMediation(() => secureIo.safeExistsSync(...args));

function safeSecretPath(filePath: string, allowMissingLeaf = true): string {
  return secureIo.withSensitivePathMediation(() =>
    secureIo.assertSafeRepositoryPath(filePath, { allowMissingLeaf })
  );
}

function parseSecretRecord(value: unknown, label: string): Record<string, unknown> | null {
  try {
    return parseSafeJsonObjectValue(value, label);
  } catch {
    return null;
  }
}

interface AuthGrant {
  missionId: string;
  serviceId?: string;
  authority?: string;
  expiresAt: number; // Timestamp
}

function isAuthGrant(value: unknown): value is AuthGrant {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.missionId === 'string' &&
    record.missionId.trim().length > 0 &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt) &&
    (record.serviceId === undefined || typeof record.serviceId === 'string') &&
    (record.authority === undefined || typeof record.authority === 'string')
  );
}

/**
 * EP-03: inside a plugin contribution only granted secrets resolve. Connection
 * documents are addressed as `connection:<serviceId>`. Minting auth grants is
 * never available to plugin code.
 */
function assertPluginAuthGrantDenied(subject: string): void {
  const context = getPluginExecutionContext();
  if (context)
    throw new PluginGrantDeniedError(context.pluginId, 'secrets', `auth-grant:${subject}`);
}

/**
 * Loads and maps secrets from personal connection files.
 */
const _loadPersonalSecrets = () => {
  try {
    const connectionsDir = safeSecretPath(PERSONAL_CONNECTIONS_DIR);
    if (!safeExistsSync(connectionsDir)) return;
    const items = safeReaddir(connectionsDir);
    for (const item of items) {
      // Per-account generations are never service-wide ambient credentials.
      if (item === 'accounts') continue;
      const fullPath = safeSecretPath(path.join(connectionsDir, item));
      const stat = safeLstat(fullPath);
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        const serviceName = item.toUpperCase();
        const subFiles = safeReaddir(fullPath).filter((f) => f.endsWith('.json'));
        for (const subFile of subFiles) {
          const subPath = safeSecretPath(path.join(fullPath, subFile), false);
          if (!safeLstat(subPath).isFile()) continue;
          const content = parseSecretRecord(
            readSensitiveJson<unknown>(subPath),
            `personal connection ${subPath}`
          );
          if (content) _mapContentToSecrets(serviceName, content);
        }
      } else if (stat.isFile() && item.endsWith('.json')) {
        const serviceName = path.basename(item, '.json').toUpperCase();
        const content = readSensitiveJson<unknown>(fullPath);
        if (isEncryptedConnectionEnvelope(content)) {
          // Imports/discovery must not unlock every encrypted account. Resolve
          // the requested identity lazily inside its explicit operation.
          continue;
        }
        const record = parseSecretRecord(content, `personal connection ${fullPath}`);
        if (record) _mapContentToSecrets(serviceName, record);
      }
    }
  } catch (_) {
    /* startup scan is best-effort; missing/corrupt docs are skipped */
  }
};

const _mapContentToSecrets = (serviceName: string, content: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string') {
      const secretKey = `${serviceName}_${key.toUpperCase()}`;
      _cachedPersonalSecrets.set(secretKey, value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      _mapContentToSecrets(serviceName, value as Record<string, unknown>);
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
  return safeSecretPath(
    path.join(PERSONAL_CONNECTIONS_DIR, `${_sanitizeServiceId(serviceId)}.json`)
  );
}

function _loadConnectionDocument(serviceId: string): Record<string, any> {
  const fullPath = _connectionPath(serviceId);
  if (!safeExistsSync(fullPath)) return {};
  let parsed: unknown;
  try {
    parsed = readSensitiveJson<unknown>(fullPath);
  } catch (_) {
    return {};
  }
  // AC-05: auto-detect the at-rest format. An encrypted document that cannot
  // be decrypted must fail loudly — the data exists, silently returning {}
  // would look like a wiped connection.
  if (isEncryptedConnectionEnvelope(parsed)) {
    return (
      parseSecretRecord(decryptConnectionDocument(parsed), `connection document ${fullPath}`) || {}
    );
  }
  return parseSecretRecord(parsed, `connection document ${fullPath}`) || {};
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
  assertPluginAuthGrantDenied(serviceIdOrAuth);
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
    hasHuman?: boolean;
    hasUI?: boolean;
    nonInteractive?: boolean;
  } = {}
): Promise<void> => {
  assertPluginAuthGrantDenied(serviceIdOrAuth);
  const opId = isAuthority ? RISKY_OPS.AUTH_GRANT_AUTHORITY : RISKY_OPS.SECRET_GRANT_ACCESS;
  const decision = requireRiskyApproval({
    opId,
    agentId: options.agentId ?? 'mission_controller',
    correlationId: options.correlationId ?? `${missionId}:${serviceIdOrAuth}`,
    channel: options.channel ?? 'system',
    ...(options.hasHuman !== undefined ? { hasHuman: options.hasHuman } : {}),
    ...(options.hasUI !== undefined ? { hasUI: options.hasUI } : {}),
    ...(options.nonInteractive !== undefined ? { nonInteractive: options.nonInteractive } : {}),
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
export const getSecret = (key: string, scope?: string, operation?: string): string | null =>
  withSecretResolutionSession(() => resolveGuardedSecret(key, scope, operation));

function resolveGuardedSecret(
  key: string,
  scope?: string,
  operation?: string,
  declaredIdentity?: { envName: string; keychainService: string; keychainAccount: string }
): string | null {
  assertPluginGrantAllows('secrets', key);
  const probeAccess = operatorProbeSecretAccess(key, scope, operation);
  if (probeAccess === false) throw new Error('[OPERATOR_SERVICE_PROBE_DENIED]');
  const currentMission = credentialExecutionIdentity().missionId;
  const authorizedScope = getRegisteredEnvText('AUTHORIZED_SCOPE');

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

    if (!activeGrant && !hasScopeIdentity && probeAccess !== true) {
      throw new Error(
        `TIBA_VIOLATION: No active temporal grant or authorized scope for service "${scope}". Access Denied.`
      );
    }
  }

  if (scope && !key.toUpperCase().startsWith(scope.toUpperCase() + '_')) {
    throw new Error(`SHIELD_VIOLATION: Key "${key}" does not match authorized scope "${scope}".`);
  }

  // Service/plugin/temporal grants above still apply. A scoped miss is final:
  // neither the operator's environment nor personal vault is a tenant fallback.
  const taskValue = resolveTaskCredential(key);
  if (taskValue !== undefined) {
    if (taskValue && taskValue.length > 8) _rememberActiveSecret(key, taskValue);
    return taskValue;
  }

  // 0. Upstream resolver (external KMS — AWS Secrets Manager, Vault, etc.)
  //    consulted first if one is registered. Returns null on miss; missing
  //    resolver falls through to the local vault chain below.
  const upstream = resolveSecretSync({ key, scope, operation });
  if (upstream && upstream.length > 0) {
    if (upstream.length > 8) _rememberActiveSecret(key, upstream);
    return upstream;
  }

  let value = getRegisteredEnvText(key);
  if (!value) value = _cachedPersonalSecrets.get(key);
  if (!value) {
    try {
      const secrets = parseSecretRecord(
        readSensitiveJson<unknown>(safeSecretPath(SECRETS_FILE)),
        'vault secrets'
      );
      const candidate = secrets?.[key];
      if (typeof candidate === 'string') value = candidate;
    } catch (_) {
      /* secrets file absent or corrupt: fall back to env-only resolution */
    }
  }

  if (value && typeof value === 'string') {
    if (value.length > 8) _rememberActiveSecret(key, value);
    return value;
  }

  // Fall through to OS keychain / file vault via canonical secret identity.
  // Dual-write from secret-introduction is the primary path; this recovers
  // keychain-only entries for service consumers. Lazy-require keeps
  // secret-bridge / secret-identity off the hot import graph for callers
  // that only need env / connection resolution (and for hermetic mocks).
  let identity = declaredIdentity;
  if (!identity) {
    try {
      const { parseEnvSecretName } = requireSecretModules(
        './secret-identity.js'
      ) as typeof import('./secret-identity.js');
      identity = parseEnvSecretName(key, scope) ?? undefined;
    } catch {
      return null;
    }
  }
  if (!identity) return null;
  try {
    const stored = loadConnectionDocument(identity.keychainService)[identity.keychainAccount];
    if (typeof stored === 'string' && stored.trim()) {
      if (stored.length > 8) _rememberActiveSecret(key, stored);
      return stored;
    }
  } catch (error) {
    // File read denial leaves the independent OS keychain path available;
    // decryption/refusal errors must not trigger another credential prompt.
    if (!(
      error instanceof Error &&
      /^\[(?:SECURITY|POLICY_VIOLATION|SENSITIVE_PATH_DENIED)\]/.test(error.message)
    ))
      throw error;
  }
  try {
    const { fetchSecretSync } = requireSecretModules(
      './secret-bridge.js'
    ) as typeof import('./secret-bridge.js');
    const bridged = fetchSecretSync(identity.keychainService, identity.keychainAccount);
    if (bridged && bridged.length > 0) {
      if (bridged.length > 8) _rememberActiveSecret(key, bridged);
      return bridged;
    }
  } catch {
    /* fallthrough miss stays null */
  }

  return null;
}

/** Resolve a declared service/key identity when its service is not in the
 * general service-endpoint catalog (for example, a reasoning provider). */
export function getSecretForIdentity(
  identity: { envName: string; keychainService: string; keychainAccount: string },
  operation?: string
): string | null {
  return withSecretResolutionSession(() =>
    resolveGuardedSecret(identity.envName, undefined, operation, identity)
  );
}

export const loadConnectionDocument = (serviceId: string): Record<string, any> => {
  assertPluginGrantAllows('secrets', `connection:${serviceId}`);
  if (credentialExecutionIdentity().tenantSlug)
    throw new Error(
      '[CREDENTIAL_CONNECTION_DENIED] Tenant execution cannot read personal connection documents'
    );
  return _loadConnectionDocument(serviceId);
};

export const storeConnectionDocument = (
  serviceId: string,
  patch: Record<string, any>,
  options: { backup?: boolean; missionId?: string; actor?: string } = {}
): { path: string; changedKeys: string[] } => {
  assertPluginGrantAllows('secrets', `connection:${serviceId}`);
  if (credentialExecutionIdentity().tenantSlug)
    throw new Error(
      '[CREDENTIAL_CONNECTION_DENIED] Tenant execution cannot mutate personal connection documents'
    );
  const fullPath = _connectionPath(serviceId);
  const existing = _loadConnectionDocument(serviceId);
  const next = { ...existing, ...patch };

  if (safeExistsSync(fullPath) && options.backup !== false) {
    // Back up the raw previous bytes: an encrypted document must never gain
    // a plaintext .bak sibling.
    const backupPath = safeSecretPath(`${fullPath}.bak`);
    safeWriteFile(backupPath, safeReadFile(fullPath, { encoding: 'utf8' }) as string, {
      mode: 0o600,
    });
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
  safeWriteFile(fullPath, serialized + '\n', { mode: 0o600 });
  try {
    safeFsyncFile(fullPath);
  } catch (_) {
    /* best-effort fsync */
  }

  const serviceName = _sanitizeServiceId(serviceId).toUpperCase();
  _clearServiceSecrets(serviceName);
  _mapContentToSecrets(serviceName, next);

  ledger.record('CONFIG_CHANGE', {
    mission_id: options.missionId || getRegisteredEnvText('MISSION_ID') || 'None',
    role: options.actor || getRegisteredEnvText('MISSION_ROLE') || 'secret_guard',
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

/** Internal material address, not an allocation, admission, or execution credential. */
export interface LocalAccountMaterialIdentity {
  serviceId: string;
  bindingId: string;
  ownerKind: 'person' | 'organization';
  ownerRef: string;
  tenantSlug?: string;
}

export interface LocalAccountMaterialReference extends LocalAccountMaterialIdentity {
  generation: string;
}

function localAccountMaterialIdentity(identity: LocalAccountMaterialIdentity): string {
  const slug = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  if (
    typeof identity.serviceId !== 'string' ||
    typeof identity.bindingId !== 'string' ||
    typeof identity.ownerRef !== 'string' ||
    !slug.test(identity.serviceId) ||
    !slug.test(identity.bindingId) ||
    (identity.ownerKind !== 'person' && identity.ownerKind !== 'organization') ||
    (identity.ownerKind === 'person'
      ? !/^user:[A-Za-z0-9._-]{1,128}$/.test(identity.ownerRef) || identity.tenantSlug !== undefined
      : typeof identity.tenantSlug !== 'string' ||
        !slug.test(identity.tenantSlug) ||
        identity.ownerRef !== identity.tenantSlug)
  )
    throw new Error('[ACCOUNT_MATERIAL_INVALID] Exact service, binding and owner required');
  return JSON.stringify([
    identity.serviceId,
    identity.bindingId,
    identity.ownerKind,
    identity.ownerRef,
    identity.tenantSlug ?? null,
  ]);
}

function assertLocalAccountMaterialAccess(): void {
  // This internal storage API does not issue store grants or bypass secure-io.
  // A future broker must supply its own reviewed, exact-material admission.
  if (getPluginExecutionContext() || credentialExecutionIdentity().tenantSlug)
    throw new Error('[ACCOUNT_MATERIAL_DENIED] Local operator storage only');
}

function localAccountMaterialPath(reference: LocalAccountMaterialReference): string {
  const identity = localAccountMaterialIdentity(reference);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      reference.generation
    )
  )
    throw new Error('[ACCOUNT_MATERIAL_INVALID] Exact generation required');
  const account = createHash('sha256').update(identity).digest('hex');
  return safeSecretPath(
    path.join(PERSONAL_CONNECTIONS_DIR, 'accounts', account, `${reference.generation}.json`)
  );
}

function validateLocalAccountMaterial(material: unknown): Record<string, string> {
  const values = parseSafeJsonObjectValue(material, 'local account material');
  const entries = Object.entries(values);
  if (
    entries.length === 0 ||
    entries.length > 64 ||
    entries.some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) ||
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 1_048_576
    )
  )
    throw new Error('[ACCOUNT_MATERIAL_INVALID] Nonempty exact secret-reference values required');
  return { ...values } as Record<string, string>;
}

/**
 * Internal storage primitive. Always encrypted with the existing key, regardless
 * of the legacy plaintext setting. Creates an immutable generation, no latest
 * pointer, ambient alias, binding, owner approval, or credential provenance.
 * The caller must already have secure-io write authority and introduction approval.
 */
export function storeLocalAccountMaterial(
  identity: LocalAccountMaterialIdentity,
  material: Record<string, string>
): LocalAccountMaterialReference {
  assertLocalAccountMaterialAccess();
  const account = localAccountMaterialIdentity(identity);
  const values = validateLocalAccountMaterial(material);
  const reference: LocalAccountMaterialReference = {
    serviceId: identity.serviceId,
    bindingId: identity.bindingId,
    ownerKind: identity.ownerKind,
    ownerRef: identity.ownerRef,
    ...(identity.tenantSlug === undefined ? {} : { tenantSlug: identity.tenantSlug }),
    generation: randomUUID(),
  };
  const fullPath = localAccountMaterialPath(reference);
  const envelope = encryptConnectionDocument(
    {
      kind: 'local-account-material',
      version: 1,
      account,
      generation: reference.generation,
      material: values,
    },
    { createKeyIfMissing: false }
  );
  safeWriteFile(fullPath, JSON.stringify(envelope) + '\n', { mode: 0o600, createOnly: true });
  for (const [key, value] of Object.entries(values)) _rememberActiveSecret(key, value);
  return reference;
}

/** Exact-generation read only; no service-wide/default account fallback. */
export function loadLocalAccountMaterial(
  reference: LocalAccountMaterialReference
): Record<string, string> {
  assertLocalAccountMaterialAccess();
  const fullPath = localAccountMaterialPath(reference);
  const raw = readSensitiveJson<unknown>(fullPath);
  if (!isEncryptedConnectionEnvelope(raw))
    throw new Error('[ACCOUNT_MATERIAL_INVALID] Encrypted material required');
  const document = decryptConnectionDocument(raw);
  if (
    document.kind !== 'local-account-material' ||
    document.version !== 1 ||
    document.account !== localAccountMaterialIdentity(reference) ||
    document.generation !== reference.generation
  )
    throw new Error('[ACCOUNT_MATERIAL_INVALID] Account or generation mismatch');
  const material = validateLocalAccountMaterial(document.material);
  for (const [key, value] of Object.entries(material)) _rememberActiveSecret(key, value);
  return material;
}

function _loadGrants(): AuthGrant[] {
  const grantsPath = safeSecretPath(GRANTS_FILE);
  if (!safeExistsSync(grantsPath)) return [];
  try {
    const parsed = readSensitiveJson<unknown>(grantsPath);
    return Array.isArray(parsed) ? parsed.filter(isAuthGrant) : [];
  } catch (_) {
    return [];
  }
}

function _saveGrants(grants: AuthGrant[]) {
  const freshGrants = grants.filter((g) => g.expiresAt > Date.now());
  const grantsPath = safeSecretPath(GRANTS_FILE);
  secureIo.withSensitivePathMediation(() => writeJson(grantsPath, freshGrants));
  try {
    safeFsyncFile(grantsPath);
  } catch (_) {
    /* best-effort fsync */
  }
}

/**
 * EP-03: the raw active secret values are host-only; inside a plugin frame
 * this throws. Masking that must also work while a plugin's governed call is
 * in flight uses `maskActiveSecrets`, which never returns a value.
 */
export const getActiveSecrets = (): string[] => {
  const context = getPluginExecutionContext();
  if (context) throw new PluginGrantDeniedError(context.pluginId, 'secrets', 'active-secrets');
  isCurrentTaskCredentialValue('');
  return Array.from(_activeSecrets).filter(
    (secret) => isCurrentTaskCredentialValue(secret) !== false
  );
};

const DEFAULT_MASK_MIN_LENGTH = 5;

/**
 * Replaces every active secret value (longer than `minLength`) occurring in
 * `text`. Inside a plugin frame only secrets granted to every enclosing frame
 * are masked and `minLength` cannot go below the default, so masking is no
 * oracle for other secrets.
 */
export const maskActiveSecrets = (
  text: string,
  replacement = '[REDACTED_SECRET]',
  minLength = DEFAULT_MASK_MIN_LENGTH
): string => {
  isCurrentTaskCredentialValue('');
  const inPlugin = getPluginExecutionContext() !== undefined;
  const threshold = inPlugin ? Math.max(minLength, DEFAULT_MASK_MIN_LENGTH) : minLength;
  let masked = text;
  for (const secret of _activeSecrets) {
    if (!secret || secret.length <= threshold) continue;
    if (isCurrentTaskCredentialValue(secret) === false) continue;
    if (inPlugin) {
      const names = _activeSecretNames.get(secret);
      const granted =
        names !== undefined &&
        [...names].some((name) => findPluginGrantDenial('secrets', name) === undefined);
      if (!granted) continue;
    }
    masked = masked.split(secret).join(replacement);
  }
  return masked;
};

/**
 * Host log redaction: masks every active secret even while a plugin frame is
 * active, because a governed op the plugin invoked may carry host secrets the
 * plugin was never granted. Inside a plugin frame `minLength` is still clamped
 * to the default so short guesses cannot be probed.
 */
export const redactActiveSecretsForHostLog = (
  text: string,
  replacement = '[REDACTED_SECRET]',
  minLength = DEFAULT_MASK_MIN_LENGTH
): string => {
  const threshold =
    getPluginExecutionContext() !== undefined
      ? Math.max(minLength, DEFAULT_MASK_MIN_LENGTH)
      : minLength;
  let masked = text;
  for (const secret of _activeSecrets) {
    if (!secret || secret.length <= threshold) continue;
    masked = masked.split(secret).join(replacement);
  }
  return masked;
};

export interface SecretValueRedactionOptions {
  /** Values to mask besides the active-secret registry (e.g. a provider's own env key). */
  readonly extraSecrets?: readonly string[];
  readonly replacement?: string;
  readonly minLength?: number;
}

/**
 * Needles for output-exit redaction: every active secret (host-log
 * semantics — other tasks' and ungranted secrets are masked too, because a
 * leaked value is worse than a masking oracle) plus `extraSecrets`, each also
 * in its JSON-escaped form so a multi-line value (PEM) that a model re-emits
 * inside a JSON string is still caught. Longest first, so a secret that
 * contains another is masked whole.
 */
const secretRedactionNeedles = (
  extraSecrets: readonly string[] = [],
  minLength = DEFAULT_MASK_MIN_LENGTH
): string[] => {
  const threshold =
    getPluginExecutionContext() !== undefined
      ? Math.max(minLength, DEFAULT_MASK_MIN_LENGTH)
      : minLength;
  const needles = new Set<string>();
  for (const secret of [..._activeSecrets, ...extraSecrets]) {
    if (!secret || secret.length <= threshold) continue;
    needles.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) needles.add(escaped);
  }
  return [...needles].sort((a, b) => b.length - a.length);
};

/**
 * Masks active secrets (and `extraSecrets`) in one string value, including
 * their JSON-escaped forms. Use on values, not on a JSON-stringified
 * aggregate — see `redactSecretsDeep` (secret-redaction.ts).
 *
 * Limits: only exact and JSON-escaped forms match — base64, URL-encoded, hex
 * or otherwise transformed values are not detected; values at or below
 * `minLength` (default 5) are skipped, and the registry itself only holds
 * values longer than 8 characters.
 */
export const redactSecretValuesInText = (
  text: string,
  options: SecretValueRedactionOptions = {}
): string => {
  const replacement = options.replacement ?? '[REDACTED_SECRET]';
  let masked = text;
  for (const needle of secretRedactionNeedles(options.extraSecrets, options.minLength)) {
    if (masked.includes(needle)) masked = masked.split(needle).join(replacement);
  }
  return masked;
};

export interface SecretStreamRedactor {
  /** Redacted text that is safe to emit now (may be shorter than the input). */
  push(chunk: string): string;
  /** Redacted remainder held back at the end of the stream. */
  flush(): string;
}

/**
 * Streaming redaction: a secret split across chunk boundaries is still
 * masked because the longest buffer suffix that could begin a secret is held
 * back until the next chunk (or `flush`). Needles are re-read on every push,
 * so a secret registered mid-stream is honored from then on.
 */
export const createSecretStreamRedactor = (
  options: SecretValueRedactionOptions = {}
): SecretStreamRedactor => {
  const replacement = options.replacement ?? '[REDACTED_SECRET]';
  let pending = '';
  const heldSuffixLength = (text: string, needles: readonly string[]): number => {
    let held = 0;
    for (const needle of needles) {
      const max = Math.min(needle.length - 1, text.length);
      for (let k = max; k > held; k -= 1) {
        if (text.endsWith(needle.slice(0, k))) {
          held = k;
          break;
        }
      }
    }
    return held;
  };
  return {
    push(chunk: string): string {
      const needles = secretRedactionNeedles(options.extraSecrets, options.minLength);
      // Work on the UNMASKED buffer: masking first would let a short secret A
      // inside a longer secret B consume B's prefix, so B's split remainder
      // would later be emitted in clear.
      const raw = pending + chunk;
      let cut = raw.length - heldSuffixLength(raw, needles);
      // Never cut through a complete occurrence: move the cut to its start.
      let moved = true;
      while (moved) {
        moved = false;
        for (const needle of needles) {
          for (let at = raw.indexOf(needle); at !== -1; at = raw.indexOf(needle, at + 1)) {
            if (at < cut && at + needle.length > cut) {
              cut = at;
              moved = true;
            }
          }
        }
      }
      pending = raw.slice(cut);
      let emit = raw.slice(0, cut);
      for (const needle of needles) {
        if (emit.includes(needle)) emit = emit.split(needle).join(replacement);
      }
      return emit;
    },
    flush(): string {
      const rest = redactSecretValuesInText(pending, options);
      pending = '';
      return rest;
    },
  };
};

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
  maskActiveSecrets,
  redactActiveSecretsForHostLog,
  grantAccess,
  grantAccessGuarded,
  checkAuthority,
  isSecretPath,
  loadConnectionDocument,
  storeConnectionDocument,
};
