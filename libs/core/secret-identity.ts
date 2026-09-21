/**
 * Canonical naming for secret introduction across approval, keychain, and
 * secret-guard / connection-document consumers.
 *
 * Approval target:  serviceId + secretKey (suffix UPPER)  e.g. gemini + API_KEY
 * Keychain:         service = serviceId, account = secretKey lower/snake
 * Env / guard key:  {SERVICE}_{SUFFIX}                    e.g. GEMINI_API_KEY
 * Connection field: suffix lower/snake                    e.g. api_key
 */

import {
  getServiceEndpointRecord,
  loadServiceEndpointsCatalog,
} from './service-endpoint-registry.js';

const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface SecretIdentity {
  serviceId: string;
  secretKey: string;
  envName: string;
  keychainService: string;
  keychainAccount: string;
  connectionField: string;
}

export function normalizeServiceId(serviceId: string): string {
  const normalized = String(serviceId || '')
    .trim()
    .toLowerCase();
  if (!SERVICE_ID_PATTERN.test(normalized)) {
    throw new Error(`[SECRET_IDENTITY_INVALID] serviceId is invalid: ${serviceId}`);
  }
  return normalized;
}

export function normalizeSecretKey(secretKey: string): string {
  const normalized = String(secretKey || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!SECRET_KEY_PATTERN.test(normalized)) {
    throw new Error(`[SECRET_IDENTITY_INVALID] secretKey is invalid: ${secretKey}`);
  }
  return normalized;
}

/** Map a credential suffix (API_KEY) to a connection-document field (api_key). */
export function secretKeyToConnectionField(secretKey: string): string {
  return normalizeSecretKey(secretKey).toLowerCase();
}

/** Map a credential suffix to a keychain account name (api_key). */
export function secretKeyToKeychainAccount(secretKey: string): string {
  return secretKeyToConnectionField(secretKey);
}

export function serviceIdToEnvPrefix(serviceId: string): string {
  return normalizeServiceId(serviceId)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}

export function buildEnvSecretName(serviceId: string, secretKey: string): string {
  return `${serviceIdToEnvPrefix(serviceId)}_${normalizeSecretKey(secretKey)}`;
}

export function resolveSecretIdentity(serviceId: string, secretKey: string): SecretIdentity {
  const id = normalizeServiceId(serviceId);
  const key = normalizeSecretKey(secretKey);
  return {
    serviceId: id,
    secretKey: key,
    envName: buildEnvSecretName(id, key),
    keychainService: id,
    keychainAccount: secretKeyToKeychainAccount(key),
    connectionField: secretKeyToConnectionField(key),
  };
}

/**
 * Parse an env-style key (GEMINI_API_KEY) into a SecretIdentity.
 * When hintServiceId is set, require that prefix. Otherwise prefer the longest
 * known service-endpoint id whose UPPER_WITH_UNDERSCORES form prefixes the key.
 */
export function parseEnvSecretName(envName: string, hintServiceId?: string): SecretIdentity | null {
  const key = String(envName || '')
    .trim()
    .toUpperCase();
  if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) return null;

  if (hintServiceId) {
    const service = normalizeServiceId(hintServiceId);
    const prefix = `${serviceIdToEnvPrefix(service)}_`;
    if (!key.startsWith(prefix)) return null;
    const suffix = key.slice(prefix.length);
    if (!suffix) return null;
    return resolveSecretIdentity(service, suffix);
  }

  const knownIds = listKnownServiceIds();
  const ranked = knownIds
    .map((id) => ({ id, prefix: `${serviceIdToEnvPrefix(id)}_` }))
    .filter((entry) => key.startsWith(entry.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  for (const entry of ranked) {
    const suffix = key.slice(entry.prefix.length);
    if (!suffix) continue;
    try {
      return resolveSecretIdentity(entry.id, suffix);
    } catch {
      continue;
    }
  }
  return null;
}

function listKnownServiceIds(): string[] {
  try {
    return Object.keys(loadServiceEndpointsCatalog().services || {});
  } catch {
    return [];
  }
}

/** Unique credential suffixes declared for a service (or bearer defaults). */
export function listServiceSecretKeys(serviceId: string): string[] {
  const id = normalizeServiceId(serviceId);
  const endpoint = getServiceEndpointRecord(id);
  const suffixes = endpoint?.credential_suffixes || {};
  const collected = new Set<string>();
  for (const list of Object.values(suffixes)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string' && item.trim()) {
        collected.add(normalizeSecretKey(item));
      }
    }
  }
  if (collected.size === 0) {
    for (const fallback of ['ACCESS_TOKEN', 'BOT_TOKEN', 'TOKEN', 'API_KEY']) {
      collected.add(fallback);
    }
  }
  return Array.from(collected).sort();
}

export function listServiceSecretIdentities(serviceId: string): SecretIdentity[] {
  return listServiceSecretKeys(serviceId).map((key) => resolveSecretIdentity(serviceId, key));
}
