import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  safeReadFile,
  safeWriteFile,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync,
  safeFsyncFile,
} from './secure-io.js';
import { resolveServiceBinding } from './service-binding.js';
import { executeServicePreset } from './service-engine.js';
import { loadConnectionDocument, storeConnectionDocument } from './secret-guard.js';

const SERVICE_ENDPOINTS_PATH = pathResolver.knowledge('public/orchestration/service-endpoints.json');
const OAUTH_SESSION_ROOT = pathResolver.sharedTmp('oauth');

export interface ServiceOAuthProfile {
  authorize_url: string;
  token_operation?: string;
  refresh_operation?: string;
  revoke_operation?: string;
  scopes?: string[];
  scope_separator?: string;
  response_type?: string;
  pkce?: boolean;
  redirect_uri?: string;
  extra_authorize_params?: Record<string, string>;
}

interface PendingOAuthSession {
  serviceId: string;
  state: string;
  codeVerifier?: string;
  redirectUri?: string;
  scopes: string[];
  createdAt: string;
}

function loadServicePreset(serviceId: string): any {
  const endpoints = JSON.parse(safeReadFile(SERVICE_ENDPOINTS_PATH, { encoding: 'utf8' }) as string);
  const serviceConfig = endpoints?.services?.[serviceId];
  if (!serviceConfig?.preset_path) {
    throw new Error(`No preset path defined for service: ${serviceId}`);
  }
  return JSON.parse(safeReadFile(pathResolver.rootResolve(serviceConfig.preset_path), { encoding: 'utf8' }) as string);
}

function serviceSessionDir(serviceId: string): string {
  return path.join(OAUTH_SESSION_ROOT, serviceId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
}

function serviceSessionPath(serviceId: string, state: string): string {
  return path.join(serviceSessionDir(serviceId), `${state}.json`);
}

function randomUrlSafe(length = 48): string {
  return crypto.randomBytes(length).toString('base64url');
}

function buildCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

function savePendingOAuthSession(session: PendingOAuthSession) {
  const dir = serviceSessionDir(session.serviceId);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
  const filePath = serviceSessionPath(session.serviceId, session.state);
  safeWriteFile(filePath, JSON.stringify(session, null, 2) + '\n');
  try { safeFsyncFile(filePath); } catch (_) {}
}

function loadPendingOAuthSession(serviceId: string, state?: string): PendingOAuthSession | null {
  const dir = serviceSessionDir(serviceId);
  if (!safeExistsSync(dir)) return null;

  if (state) {
    const filePath = serviceSessionPath(serviceId, state);
    if (!safeExistsSync(filePath)) return null;
    try {
      return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    } catch (_) {
      return null;
    }
  }

  try {
    const files = safeReaddir(dir).filter((file) => file.endsWith('.json')).sort().reverse();
    if (files.length === 0) return null;
    return JSON.parse(safeReadFile(path.join(dir, files[0]), { encoding: 'utf8' }) as string);
  } catch (_) {
    return null;
  }
}

function clearPendingOAuthSession(serviceId: string, state: string) {
  const filePath = serviceSessionPath(serviceId, state);
  if (safeExistsSync(filePath)) {
    safeUnlinkSync(filePath);
  }
}

function listPendingOAuthSessions(): PendingOAuthSession[] {
  if (!safeExistsSync(OAUTH_SESSION_ROOT)) return [];
  const sessions: PendingOAuthSession[] = [];
  try {
    for (const serviceDir of safeReaddir(OAUTH_SESSION_ROOT)) {
      const fullDir = path.join(OAUTH_SESSION_ROOT, serviceDir);
      if (!safeExistsSync(fullDir)) continue;
      for (const fileName of safeReaddir(fullDir)) {
        if (!fileName.endsWith('.json')) continue;
        try {
          const session = JSON.parse(safeReadFile(path.join(fullDir, fileName), { encoding: 'utf8' }) as string) as PendingOAuthSession;
          sessions.push(session);
        } catch (_) {}
      }
    }
  } catch (_) {}
  return sessions;
}

function normalizeScopes(scopes?: string[] | string): string[] {
  if (!scopes) return [];
  if (Array.isArray(scopes)) return scopes.filter(Boolean);
  return scopes.split(/[ ,]+/).map((value) => value.trim()).filter(Boolean);
}

export function loadServiceOAuthProfile(serviceId: string): ServiceOAuthProfile {
  const preset = loadServicePreset(serviceId);
  if (!preset?.oauth?.authorize_url) {
    throw new Error(`Service "${serviceId}" does not define an oauth profile`);
  }
  return preset.oauth as ServiceOAuthProfile;
}

export function findPendingOAuthSessionByState(state: string): PendingOAuthSession | null {
  if (!state) return null;
  return listPendingOAuthSessions().find((session) => session.state === state) || null;
}

export function beginServiceOAuth(
  serviceId: string,
  options: {
    state?: string;
    scopes?: string[];
    redirectUri?: string;
    persistSession?: boolean;
  } = {},
) {
  const profile = loadServiceOAuthProfile(serviceId);
  const binding = resolveServiceBinding(serviceId, 'secret-guard');
  if (!binding.clientId) {
    throw new Error(`OAuth begin requires ${serviceId.toUpperCase()}_CLIENT_ID`);
  }

  const scopes = normalizeScopes(options.scopes || profile.scopes);
  const redirectUri = options.redirectUri || binding.redirectUri || profile.redirect_uri;
  const state = options.state || randomUrlSafe(24);
  const codeVerifier = profile.pkce === false ? undefined : randomUrlSafe(48);
  const codeChallenge = codeVerifier ? buildCodeChallenge(codeVerifier) : undefined;
  const query = new URLSearchParams({
    response_type: profile.response_type || 'code',
    client_id: binding.clientId,
    state,
  });

  if (redirectUri) query.set('redirect_uri', redirectUri);
  if (scopes.length > 0) query.set('scope', scopes.join(profile.scope_separator || ' '));
  if (codeChallenge) {
    query.set('code_challenge', codeChallenge);
    query.set('code_challenge_method', 's256');
  }
  for (const [key, value] of Object.entries(profile.extra_authorize_params || {})) {
    query.set(key, value);
  }

  if (options.persistSession !== false) {
    savePendingOAuthSession({
      serviceId,
      state,
      codeVerifier,
      redirectUri,
      scopes,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    serviceId,
    state,
    scopes,
    redirectUri,
    codeVerifier,
    authorizationUrl: `${profile.authorize_url}?${query.toString()}`,
  };
}

function persistOAuthTokens(
  serviceId: string,
  result: Record<string, any>,
  redirectUri?: string,
) {
  const patch: Record<string, any> = {};
  if (typeof result.access_token === 'string') patch.access_token = result.access_token;
  if (typeof result.refresh_token === 'string') patch.refresh_token = result.refresh_token;
  if (typeof result.scope === 'string') patch.scope = result.scope;
  if (typeof result.token_type === 'string') patch.token_type = result.token_type;
  if (typeof result.expires_in === 'number' && Number.isFinite(result.expires_in)) {
    patch.expires_at = new Date(Date.now() + result.expires_in * 1000).toISOString();
  }
  if (redirectUri) patch.redirect_uri = redirectUri;

  const persisted = Object.keys(patch).length > 0
    ? storeConnectionDocument(serviceId, patch, { actor: 'oauth_broker' })
    : null;

  return { patch, persisted };
}

export async function exchangeServiceOAuthCode(
  serviceId: string,
  input: {
    code: string;
    state?: string;
    codeVerifier?: string;
    redirectUri?: string;
  },
) {
  const profile = loadServiceOAuthProfile(serviceId);
  const pending = loadPendingOAuthSession(serviceId, input.state);
  const redirectUri = input.redirectUri || pending?.redirectUri;
  const codeVerifier = input.codeVerifier || pending?.codeVerifier;

  if (profile.pkce !== false && !codeVerifier) {
    throw new Error(`OAuth code exchange for "${serviceId}" requires a code verifier`);
  }

  const result = await executeServicePreset(serviceId, profile.token_operation || 'exchange_oauth_code', {
    code: input.code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  }, 'secret-guard');

  const persisted = persistOAuthTokens(serviceId, result, redirectUri);
  if (pending?.state) clearPendingOAuthSession(serviceId, pending.state);

  return {
    serviceId,
    ...result,
    persisted_path: persisted.persisted?.path,
    persisted_keys: persisted.persisted?.changedKeys || [],
  };
}

export async function refreshServiceOAuthToken(
  serviceId: string,
  input: {
    refreshToken?: string;
  } = {},
) {
  const profile = loadServiceOAuthProfile(serviceId);
  const binding = resolveServiceBinding(serviceId, 'secret-guard');
  const existing = loadConnectionDocument(serviceId);
  const refreshToken = input.refreshToken || binding.refreshToken || (typeof existing.refresh_token === 'string' ? existing.refresh_token : undefined);

  if (!refreshToken) {
    throw new Error(`OAuth token refresh for "${serviceId}" requires a refresh token`);
  }

  const result = await executeServicePreset(serviceId, profile.refresh_operation || profile.token_operation || 'refresh_oauth_token', {
    refresh_token: refreshToken,
  }, 'secret-guard');

  const persisted = persistOAuthTokens(serviceId, result, binding.redirectUri || (typeof existing.redirect_uri === 'string' ? existing.redirect_uri : undefined));
  return {
    serviceId,
    ...result,
    persisted_path: persisted.persisted?.path,
    persisted_keys: persisted.persisted?.changedKeys || [],
  };
}

export async function completeOAuthCallback(input: {
  serviceId?: string;
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}) {
  if (input.error) {
    return {
      ok: false,
      serviceId: input.serviceId,
      error: input.error,
      errorDescription: input.errorDescription || '',
    };
  }

  if (!input.code) {
    throw new Error('OAuth callback requires a code');
  }

  const pending = input.state ? findPendingOAuthSessionByState(input.state) : null;
  const serviceId = input.serviceId || pending?.serviceId;
  if (!serviceId) {
    throw new Error('Unable to resolve service for OAuth callback');
  }

  const result = await exchangeServiceOAuthCode(serviceId, {
    code: input.code,
    state: input.state,
    codeVerifier: pending?.codeVerifier,
    redirectUri: pending?.redirectUri,
  });

  return {
    ok: true,
    serviceId,
    result,
  };
}
