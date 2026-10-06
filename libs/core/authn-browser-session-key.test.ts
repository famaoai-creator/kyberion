import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  document: undefined as { hmac_key?: string } | undefined,
  denied: false,
}));
vi.mock('./secret/secret-guard.js', () => ({
  secretGuard: {
    loadConnectionDocument: () => {
      if (state.denied) throw new Error('denied');
      return state.document;
    },
  },
}));
import { browserSessionKey, BROWSER_SESSION_MIN_KEY_BYTES } from './authn-browser-session-key.js';
import {
  browserSessionKey as compatibilityKey,
  mintBrowserSessionToken,
  verifyBrowserSessionToken,
} from './authn-providers.js';
beforeEach(() => {
  state.document = undefined;
  state.denied = false;
});
describe('browser-session key leaf', () => {
  it('keeps the public key export identical and accepts the same strong env key', () => {
    expect(compatibilityKey).toBe(browserSessionKey);
    expect(BROWSER_SESSION_MIN_KEY_BYTES).toBe(32);
    expect(
      browserSessionKey({
        env: { KYBERION_SESSION_SECRET: '  ' + 'x'.repeat(32) + '  ' },
      })?.toString()
    ).toBe('x'.repeat(32));
  });
  it('fails closed on an explicitly weak env key instead of falling back', () => {
    state.document = { hmac_key: 'y'.repeat(32) };
    expect(browserSessionKey({ env: { KYBERION_SESSION_SECRET: 'short' } })).toBeNull();
  });
  it('retains the existing guarded document fallback, trimming, and weak/missing handling', () => {
    state.document = { hmac_key: '  ' + 'y'.repeat(32) + '  ' };
    expect(browserSessionKey({ env: {} })?.toString()).toBe('y'.repeat(32));
    state.document = { hmac_key: 'short' };
    expect(browserSessionKey({ env: {} })).toBeNull();
    state.document = undefined;
    expect(browserSessionKey({ env: {} })).toBeNull();
    state.denied = true;
    expect(browserSessionKey({ env: {} })).toBeNull();
  });
  it('preserves session HMAC, expiry, and rotation behavior through the compatibility provider', () => {
    const deps = { env: { KYBERION_SESSION_SECRET: 'z'.repeat(32) }, now: 1700000000000 };
    const minted = mintBrowserSessionToken(
      { idpIssuer: 'https://fixture.example', subject: 'fixture', ttlSeconds: 60 },
      deps
    );
    expect(verifyBrowserSessionToken(minted.token, deps)).toEqual(minted.payload);
    expect(verifyBrowserSessionToken(minted.token + 'x', deps)).toBeNull();
    expect(verifyBrowserSessionToken(minted.token, { ...deps, now: deps.now + 60000 })).toBeNull();
    expect(
      verifyBrowserSessionToken(minted.token, {
        ...deps,
        env: { KYBERION_SESSION_SECRET: 'w'.repeat(32) },
      })
    ).toBeNull();
  });
});
