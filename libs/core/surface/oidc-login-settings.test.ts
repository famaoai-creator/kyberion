import { afterEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('../secret/secret-guard.js', () => ({
  secretGuard: {
    loadConnectionDocument: (id: string) => ({ ...(store.get(id) ?? {}) }),
    storeConnectionDocument: (id: string, patch: Record<string, unknown>) => {
      store.set(id, { ...(store.get(id) ?? {}), ...patch });
      return { path: id, changedKeys: Object.keys(patch) };
    },
  },
}));

import {
  BROWSER_SESSION_DOCUMENT,
  OIDC_SETTINGS_DOCUMENT,
  OidcSettingsInputError,
  loadStoredOidcLoginSettings,
  normalizeOidcLoginSettingsInput,
  saveOidcLoginSettings,
  summarizeOidcLoginSettings,
} from './oidc-login-settings.js';

const OIDC_ENV = [
  'KYBERION_OIDC_ISSUER',
  'KYBERION_OIDC_CLIENT_ID',
  'KYBERION_OIDC_CLIENT_SECRET',
  'KYBERION_SESSION_SECRET',
];

function field(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OidcSettingsInputError);
    return (error as OidcSettingsInputError).field;
  }
  throw new Error('expected OidcSettingsInputError');
}

describe('oidc-login-settings', () => {
  afterEach(() => {
    store.clear();
    vi.unstubAllEnvs();
  });
  const clearEnv = () => OIDC_ENV.forEach((name) => vi.stubEnv(name, ''));

  it('normalizes issuer / base URL and rejects unsafe values', () => {
    expect(
      normalizeOidcLoginSettingsInput({
        issuer: ' https://login.microsoftonline.com/tid/v2.0/ ',
        client_id: 'abc',
        public_base_url: 'https://desk.example.com/',
        scopes: 'openid email',
      })
    ).toEqual({
      issuer: 'https://login.microsoftonline.com/tid/v2.0',
      client_id: 'abc',
      public_base_url: 'https://desk.example.com',
      scopes: 'openid email',
    });
    expect(
      normalizeOidcLoginSettingsInput({ issuer: 'http://localhost:9099', client_id: 'dev' }).issuer
    ).toBe('http://localhost:9099');
    expect(
      field(() => normalizeOidcLoginSettingsInput({ issuer: 'http://idp.example', client_id: 'a' }))
    ).toBe('issuer');
    expect(
      field(() =>
        normalizeOidcLoginSettingsInput({ issuer: 'https://u:p@idp.example', client_id: 'a' })
      )
    ).toBe('issuer');
    expect(
      field(() =>
        normalizeOidcLoginSettingsInput({ issuer: 'https://idp.example', client_id: 'a b' })
      )
    ).toBe('client_id');
    expect(
      field(() =>
        normalizeOidcLoginSettingsInput({
          issuer: 'https://idp.example',
          client_id: 'a',
          public_base_url: 'https://desk.example.com/path',
        })
      )
    ).toBe('public_base_url');
    expect(
      field(() =>
        normalizeOidcLoginSettingsInput({
          issuer: 'https://idp.example',
          client_id: 'a',
          scopes: 'openid "x"',
        })
      )
    ).toBe('scopes');
  });

  it('stores settings, generates a session key, and never reveals the secret', () => {
    clearEnv();
    const result = saveOidcLoginSettings({
      issuer: 'https://accounts.google.com',
      client_id: 'cid',
      client_secret: 'top-secret',
      provider_label: 'Google',
    });
    expect(result.session_key).toBe('generated');
    expect(result.env_overrides).toBe(false);
    expect(String(store.get(BROWSER_SESSION_DOCUMENT)?.hmac_key)).toMatch(/^[a-f0-9]{64}$/);
    expect(result.summary).toMatchObject({
      source: 'stored',
      issuer: 'https://accounts.google.com',
      client_id: 'cid',
      provider_label: 'Google',
      client_secret_set: true,
      session_key_ready: true,
    });
    expect(JSON.stringify(result.summary)).not.toContain('top-secret');
    expect(loadStoredOidcLoginSettings()?.client_secret).toBe('top-secret');

    // Omitting the secret keeps it; an empty string clears it; dropped optionals clear.
    saveOidcLoginSettings({ issuer: 'https://accounts.google.com', client_id: 'cid2' });
    expect(loadStoredOidcLoginSettings()).toMatchObject({
      client_id: 'cid2',
      client_secret: 'top-secret',
    });
    expect(loadStoredOidcLoginSettings()?.provider_label).toBeUndefined();
    saveOidcLoginSettings({
      issuer: 'https://accounts.google.com',
      client_id: 'cid2',
      client_secret: '',
    });
    expect(loadStoredOidcLoginSettings()?.client_secret).toBeUndefined();
    expect(store.get(OIDC_SETTINGS_DOCUMENT)?.updated_at).toEqual(expect.any(String));
  });

  it('reports environment precedence and a weak env session secret', () => {
    clearEnv();
    vi.stubEnv('KYBERION_SESSION_SECRET', 'short');
    vi.stubEnv('KYBERION_OIDC_ISSUER', 'https://env.example');
    const result = saveOidcLoginSettings({ issuer: 'https://idp.example', client_id: 'a' });
    expect(result.session_key).toBe('env_weak');
    expect(result.env_overrides).toBe(true);
    expect(store.has(BROWSER_SESSION_DOCUMENT)).toBe(false);
    expect(summarizeOidcLoginSettings()).toMatchObject({
      source: 'env',
      issuer: 'https://env.example',
      session_key_ready: false,
    });
  });
});
