/**
 * oidc-login-settings — browser-login OIDC settings kept in secret-guard so an
 * owner can configure SSO from a surface (first-run setup) instead of editing
 * environment variables and restarting every surface process.
 *
 * Precedence is all-or-nothing: when `KYBERION_OIDC_ISSUER` or
 * `KYBERION_OIDC_CLIENT_ID` is set in the environment, the environment set is
 * used and the stored document is ignored (see `resolveOidcLoginConfig`).
 * The client secret is never returned by {@link summarizeOidcLoginSettings}.
 */

import { randomBytes } from 'node:crypto';
import { browserSessionKey } from '../authn-browser-session-key.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { nowIso } from '../foundation/time.js';
import { secretGuard } from '../secret/secret-guard.js';

export const OIDC_SETTINGS_DOCUMENT = 'kyberion-oidc';
export const BROWSER_SESSION_DOCUMENT = 'kyberion-browser-session';

export interface StoredOidcLoginSettings {
  issuer: string;
  client_id: string;
  client_secret?: string;
  provider_label?: string;
  scopes?: string;
  public_base_url?: string;
  updated_at?: string;
}

export interface OidcLoginSettingsInput {
  issuer?: unknown;
  client_id?: unknown;
  /** Omitted keeps the stored secret; an empty string clears it. */
  client_secret?: unknown;
  provider_label?: unknown;
  scopes?: unknown;
  public_base_url?: unknown;
}

export type OidcSettingsField = keyof OidcLoginSettingsInput;

export class OidcSettingsInputError extends Error {
  constructor(public readonly field: OidcSettingsField) {
    super(`invalid OIDC setting: ${field}`);
    this.name = 'OidcSettingsInputError';
  }
}

type Env = Record<string, string | undefined> | undefined;

function envText(env: Env, name: string): string | undefined {
  return getRegisteredEnvText(name, env ? { env } : undefined)?.trim() || undefined;
}

/** True when the environment supplies the OIDC set (it then wins over stored settings). */
export function oidcEnvConfigured(env?: Env): boolean {
  return Boolean(envText(env, 'KYBERION_OIDC_ISSUER') || envText(env, 'KYBERION_OIDC_CLIENT_ID'));
}

function isLoopbackHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/** https, or http only for a loopback host (local IdP / local surface). */
function normalizeOrigin(value: string, keepPath: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  ) {
    return null;
  }
  if (!keepPath) return url.pathname === '/' ? url.origin : null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

function optionalText(
  input: OidcLoginSettingsInput,
  field: OidcSettingsField,
  max: number
): string | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new OidcSettingsInputError(field);
  const value = raw.trim();
  if (value.length > max || CONTROL_CHARS.test(value)) throw new OidcSettingsInputError(field);
  return value;
}

export interface NormalizedOidcLoginSettings {
  issuer: string;
  client_id: string;
  /** undefined = keep stored value, '' = clear. */
  client_secret?: string;
  provider_label?: string;
  scopes?: string;
  public_base_url?: string;
}

export function normalizeOidcLoginSettingsInput(
  input: OidcLoginSettingsInput
): NormalizedOidcLoginSettings {
  const issuerText = optionalText(input, 'issuer', 512);
  const issuer = issuerText ? normalizeOrigin(issuerText, true) : null;
  if (!issuer) throw new OidcSettingsInputError('issuer');
  const clientId = optionalText(input, 'client_id', 256);
  if (!clientId || /\s/.test(clientId)) throw new OidcSettingsInputError('client_id');
  const clientSecret = optionalText(input, 'client_secret', 1024);
  const providerLabel = optionalText(input, 'provider_label', 40);
  const scopes = optionalText(input, 'scopes', 200);
  if (scopes && !scopes.split(/\s+/).every((token) => SCOPE_TOKEN.test(token))) {
    throw new OidcSettingsInputError('scopes');
  }
  const baseText = optionalText(input, 'public_base_url', 512);
  const publicBaseUrl = baseText ? normalizeOrigin(baseText, false) : undefined;
  if (baseText && !publicBaseUrl) throw new OidcSettingsInputError('public_base_url');
  return {
    issuer,
    client_id: clientId,
    ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
    ...(providerLabel ? { provider_label: providerLabel } : {}),
    ...(scopes ? { scopes } : {}),
    ...(publicBaseUrl ? { public_base_url: publicBaseUrl } : {}),
  };
}

function stringField(doc: Record<string, unknown>, key: string): string | undefined {
  const value = doc[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The stored settings, or null when absent / unreadable / incomplete. */
export function loadStoredOidcLoginSettings(): StoredOidcLoginSettings | null {
  let doc: Record<string, unknown>;
  try {
    doc = secretGuard.loadConnectionDocument(OIDC_SETTINGS_DOCUMENT) as Record<string, unknown>;
  } catch {
    return null;
  }
  const issuer = stringField(doc, 'issuer');
  const clientId = stringField(doc, 'client_id');
  if (!issuer || !clientId) return null;
  const optional = (key: keyof StoredOidcLoginSettings) => {
    const value = stringField(doc, key);
    return value ? { [key]: value } : {};
  };
  return {
    issuer,
    client_id: clientId,
    ...optional('client_secret'),
    ...optional('provider_label'),
    ...optional('scopes'),
    ...optional('public_base_url'),
    ...optional('updated_at'),
  };
}

export type SessionKeyState = 'existing' | 'generated' | 'env_weak';

/**
 * Make sure a browser-session signing key exists. A configured but too-short
 * `KYBERION_SESSION_SECRET` shadows the stored key, so it is reported rather
 * than silently papered over.
 */
export function ensureBrowserSessionKey(actor?: string): SessionKeyState {
  if (browserSessionKey()) return 'existing';
  if (envText(undefined, 'KYBERION_SESSION_SECRET')) return 'env_weak';
  secretGuard.storeConnectionDocument(
    BROWSER_SESSION_DOCUMENT,
    { hmac_key: randomBytes(32).toString('hex') },
    actor ? { actor } : {}
  );
  return browserSessionKey() ? 'generated' : 'env_weak';
}

export interface OidcLoginSettingsSummary {
  source: 'env' | 'stored' | 'none';
  issuer?: string;
  client_id?: string;
  provider_label?: string;
  scopes?: string;
  public_base_url?: string;
  client_secret_set: boolean;
  session_key_ready: boolean;
  updated_at?: string;
}

/** What an owner may see about the active settings. Never includes the secret. */
export function summarizeOidcLoginSettings(): OidcLoginSettingsSummary {
  const sessionKeyReady = browserSessionKey() !== null;
  if (oidcEnvConfigured()) {
    const issuer = envText(undefined, 'KYBERION_OIDC_ISSUER');
    const clientId = envText(undefined, 'KYBERION_OIDC_CLIENT_ID');
    const label = envText(undefined, 'KYBERION_OIDC_PROVIDER_LABEL');
    const scopes = envText(undefined, 'KYBERION_OIDC_SCOPES');
    const base = envText(undefined, 'KYBERION_OIDC_PUBLIC_BASE_URL');
    return {
      source: 'env',
      ...(issuer ? { issuer } : {}),
      ...(clientId ? { client_id: clientId } : {}),
      ...(label ? { provider_label: label } : {}),
      ...(scopes ? { scopes } : {}),
      ...(base ? { public_base_url: base } : {}),
      client_secret_set: Boolean(envText(undefined, 'KYBERION_OIDC_CLIENT_SECRET')),
      session_key_ready: sessionKeyReady,
    };
  }
  const stored = loadStoredOidcLoginSettings();
  if (!stored)
    return { source: 'none', client_secret_set: false, session_key_ready: sessionKeyReady };
  const { client_secret: secret, ...visible } = stored;
  return {
    source: 'stored',
    ...visible,
    client_secret_set: Boolean(secret),
    session_key_ready: sessionKeyReady,
  };
}

export interface SaveOidcLoginSettingsResult {
  summary: OidcLoginSettingsSummary;
  session_key: SessionKeyState;
  /** True when environment variables override what was just stored. */
  env_overrides: boolean;
}

/** Validate and store the settings; generates the session key when missing. */
export function saveOidcLoginSettings(
  input: OidcLoginSettingsInput,
  options: { actor?: string } = {}
): SaveOidcLoginSettingsResult {
  const normalized = normalizeOidcLoginSettingsInput(input);
  const { client_secret: secret, ...rest } = normalized;
  const patch: Record<string, unknown> = {
    provider_label: null,
    scopes: null,
    public_base_url: null,
    ...rest,
    updated_at: nowIso(),
  };
  if (secret !== undefined) patch.client_secret = secret === '' ? null : secret;
  secretGuard.storeConnectionDocument(
    OIDC_SETTINGS_DOCUMENT,
    patch,
    options.actor ? { actor: options.actor } : {}
  );
  const sessionKey = ensureBrowserSessionKey(options.actor);
  return {
    summary: summarizeOidcLoginSettings(),
    session_key: sessionKey,
    env_overrides: oidcEnvConfigured(),
  };
}
