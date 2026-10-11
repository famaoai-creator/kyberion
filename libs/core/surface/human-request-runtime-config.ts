/** Explicit, nonsecret server configuration. No path means both adapters are off. */
import { getRegisteredEnvText } from '../foundation/env.js';
import { readJson } from '../foundation/json.js';
import { isRecord } from '../foundation/primitives.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import {
  isBoundedHumanRequestText,
  isValidHumanRequestAuthorityNamespace,
  normalizeHumanRequestScopeList,
  normalizeHumanRequestScopeIds,
  normalizeHumanRequestTiers,
} from './verified-human-request-contract.js';
import {
  HUMAN_REQUEST_READ_SCOPE,
  HUMAN_REQUEST_RECEIVE_SCOPE,
  type HumanRequestServerPolicy,
} from './verified-human-request-identity.js';

export interface HumanRequestRuntimeConfig {
  version: 1;
  policy?: HumanRequestServerPolicy;
  browser?: { enabled: boolean; operationScopes?: string[] };
  httpMcp?: {
    enabled: boolean;
    token?: {
      issuer: string;
      resource: string;
      algorithms: ('RS256' | 'ES256')[];
      jwks: { keys: Record<string, unknown>[] };
    };
    allowedOrigins?: string[];
    deployment?: { mode: 'loopback-reverse-proxy'; host: '127.0.0.1' | '::1'; port: number };
  };
}

export class HumanRequestConfigError extends Error {
  constructor() {
    super('Human request configuration is invalid or unavailable.');
    this.name = 'HumanRequestConfigError';
  }
}
function fail(): never {
  throw new HumanRequestConfigError();
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) fail();
  return value;
}
function text(value: unknown): string {
  if (!isBoundedHumanRequestText(value, 2048) || value.trim() !== value) fail();
  return value;
}
function https(value: unknown, originOnly = false): string {
  const input = text(value);
  if (!input.startsWith('https://') || /[\s\\*?#]/u.test(input)) fail();
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    (originOnly && url.origin !== input)
  )
    fail();
  return input;
}
function policy(value: unknown): HumanRequestServerPolicy {
  const row = object(value, [
    'authorityNamespace',
    'tenantSlugs',
    'organizationIds',
    'projectIds',
    'tierAccess',
  ]);
  if (!isValidHumanRequestAuthorityNamespace(row.authorityNamespace)) fail();
  return {
    authorityNamespace: row.authorityNamespace as string,
    tenantSlugs: normalizeHumanRequestScopeList(row.tenantSlugs, isValidTenantSlug),
    organizationIds: normalizeHumanRequestScopeIds(row.organizationIds),
    projectIds: normalizeHumanRequestScopeIds(row.projectIds),
    tierAccess: normalizeHumanRequestTiers(row.tierAccess),
  };
}
function token(
  value: unknown
): NonNullable<NonNullable<HumanRequestRuntimeConfig['httpMcp']>['token']> {
  const row = object(value, ['issuer', 'resource', 'algorithms', 'jwks']);
  if (
    !Array.isArray(row.algorithms) ||
    !row.algorithms.length ||
    row.algorithms.length > 2 ||
    row.algorithms.some((item) => item !== 'RS256' && item !== 'ES256') ||
    new Set(row.algorithms).size !== row.algorithms.length
  )
    fail();
  const jwks = object(row.jwks, ['keys']);
  if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 16) fail();
  const keys = jwks.keys.map((value) => {
    const key = object(value, ['kty', 'kid', 'alg', 'use', 'key_ops', 'n', 'e', 'crv', 'x', 'y']);
    for (const [name, item] of Object.entries(key)) {
      if (name === 'key_ops') {
        if (!Array.isArray(item) || item.length !== 1 || item[0] !== 'verify') fail();
      } else text(item);
    }
    return structuredClone(key);
  });
  const resource = https(row.resource);
  if (new URL(resource).pathname === '/') fail();
  return { issuer: https(row.issuer), resource, algorithms: [...row.algorithms], jwks: { keys } };
}

/** Pure strict parser. No provider discovery, secret lookup or listener activation. */
export function parseHumanRequestRuntimeConfig(value: unknown): HumanRequestRuntimeConfig {
  try {
    const row = object(value, ['version', 'policy', 'browser', 'httpMcp']);
    if (row.version !== 1) fail();
    const result: HumanRequestRuntimeConfig = { version: 1 };
    if (row.policy !== undefined) result.policy = policy(row.policy);
    if (row.browser !== undefined) {
      const browser = object(row.browser, ['enabled', 'operationScopes']);
      if (typeof browser.enabled !== 'boolean') fail();
      const scopes = browser.operationScopes;
      if (
        scopes !== undefined &&
        (!Array.isArray(scopes) ||
          !scopes.length ||
          scopes.length > 2 ||
          scopes.some(
            (item) => item !== HUMAN_REQUEST_READ_SCOPE && item !== HUMAN_REQUEST_RECEIVE_SCOPE
          ) ||
          new Set(scopes).size !== scopes.length)
      )
        fail();
      if (browser.enabled && (!result.policy || scopes === undefined)) fail();
      result.browser = {
        enabled: browser.enabled,
        ...(scopes !== undefined ? { operationScopes: [...(scopes as string[])] } : {}),
      };
    }
    if (row.httpMcp !== undefined) {
      const mcp = object(row.httpMcp, ['enabled', 'token', 'allowedOrigins', 'deployment']);
      if (typeof mcp.enabled !== 'boolean') fail();
      result.httpMcp = { enabled: mcp.enabled };
      if (mcp.token !== undefined) result.httpMcp.token = token(mcp.token);
      if (mcp.enabled && (!result.policy || !result.httpMcp.token)) fail();
      if (mcp.allowedOrigins !== undefined) {
        if (!Array.isArray(mcp.allowedOrigins) || mcp.allowedOrigins.length > 32) fail();
        result.httpMcp.allowedOrigins = mcp.allowedOrigins.map((value) => https(value, true));
      }
      if (mcp.deployment !== undefined) {
        const deployment = object(mcp.deployment, ['mode', 'host', 'port']);
        if (
          deployment.mode !== 'loopback-reverse-proxy' ||
          (deployment.host !== '127.0.0.1' && deployment.host !== '::1') ||
          typeof deployment.port !== 'number' ||
          !Number.isInteger(deployment.port) ||
          deployment.port < 1 ||
          deployment.port > 65535
        )
          fail();
        result.httpMcp.deployment = {
          mode: deployment.mode,
          host: deployment.host,
          port: deployment.port,
        };
      }
    }
    return result;
  } catch {
    fail();
  }
}

/** Re-read on every browser request. A configured missing/unreadable file is never disabled fallback. */
export function loadHumanRequestRuntimeConfig(path?: string): HumanRequestRuntimeConfig {
  try {
    const configured = path ?? getRegisteredEnvText('KYBERION_HUMAN_REQUEST_CONFIG');
    if (configured === undefined || configured === '') return { version: 1 };
    if (configured.trim() !== configured || !configured.trim()) fail();
    return parseHumanRequestRuntimeConfig(readJson<unknown>(configured));
  } catch {
    fail();
  }
}
