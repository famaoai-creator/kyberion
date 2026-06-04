import { loadServiceEndpointsCatalog, resolveServiceBinding } from './service-binding.js';
import { executeServicePreset } from './service-engine.js';
import { loadConnectionDocument, storeConnectionDocument } from './secret-guard.js';
import { getServicePresetRecord } from './service-preset-registry.js';
import {
  buildCodeChallenge,
  clearPendingOAuthSession,
  findPendingOAuthSessionByState,
  loadPendingOAuthSession,
  normalizeScopes,
  randomUrlSafe,
  savePendingOAuthSession,
  type PendingOAuthSession,
} from './oauth-session-store.js';

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

function loadServicePreset(serviceId: string): any {
  const endpoints = loadServiceEndpointsCatalog();
  const serviceConfig = endpoints.services?.[serviceId];
  const preset = getServicePresetRecord(serviceId, serviceConfig?.preset_path);
  if (!preset) {
    throw new Error(`No preset path defined for service: ${serviceId}`);
  }
  return preset;
}

export function loadServiceOAuthProfile(serviceId: string): ServiceOAuthProfile {
  const preset = loadServicePreset(serviceId);
  if (!preset?.oauth?.authorize_url) {
    throw new Error(`Service "${serviceId}" does not define an oauth profile`);
  }
  return preset.oauth as ServiceOAuthProfile;
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
