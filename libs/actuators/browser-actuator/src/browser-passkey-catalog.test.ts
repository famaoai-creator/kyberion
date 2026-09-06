import { describe, expect, it } from 'vitest';
import { parsePasskeyProviderCatalog } from './browser-passkey-helpers.js';

const VALID_PRESET = {
  baseUrl: 'https://webauthn.io/',
  usernameSelector: '#input-email',
  registerSelector: '#register-button',
  authenticateSelector: '#login-button',
  postAuthUrlIncludes: '/profile',
};

describe('parsePasskeyProviderCatalog', () => {
  it('normalizes valid provider presets and ignores unknown fields', () => {
    expect(
      parsePasskeyProviderCatalog({
        default_provider: 'webauthn.io',
        providers: {
          'webauthn.io': { ...VALID_PRESET, ignored: { nested: true } },
          malformed: { ...VALID_PRESET, authenticateSelector: 42 },
        },
      })
    ).toEqual({
      default_provider: 'webauthn.io',
      providers: { 'webauthn.io': VALID_PRESET },
    });
  });

  it('fails closed for malformed roots, dangerous keys, and empty catalogs', () => {
    expect(parsePasskeyProviderCatalog(null)).toBeUndefined();
    expect(parsePasskeyProviderCatalog([])).toBeUndefined();
    expect(parsePasskeyProviderCatalog({ providers: [] })).toBeUndefined();
    expect(
      parsePasskeyProviderCatalog({
        providers: JSON.parse(
          '{"__proto__":{"baseUrl":"x","usernameSelector":"x","registerSelector":"x","authenticateSelector":"x"}}'
        ),
      })
    ).toBeUndefined();
  });
});
