import { describe, expect, it } from 'vitest';
import {
  isOAuthSessionExpired,
  isSafeOAuthState,
  serviceSessionPath,
} from './oauth-session-store.js';

describe('oauth session hygiene', () => {
  it('treats malformed and elapsed expiry as expired', () => {
    const now = Date.parse('2026-08-09T00:00:00.000Z');
    expect(isOAuthSessionExpired({ expiresAt: 'not-a-date' }, now)).toBe(true);
    expect(isOAuthSessionExpired({ expiresAt: '2026-08-08T23:59:59.000Z' }, now)).toBe(true);
    expect(isOAuthSessionExpired({ expiresAt: '2026-08-09T00:00:01.000Z' }, now)).toBe(false);
    expect(isOAuthSessionExpired({}, now)).toBe(true);
  });

  it('keeps OAuth state confined to a safe filename component', () => {
    expect(isSafeOAuthState('A'.repeat(32))).toBe(true);
    expect(isSafeOAuthState('../escape')).toBe(false);
    expect(isSafeOAuthState('short')).toBe(false);
    expect(() => serviceSessionPath('canva', '../escape')).toThrow('safe');
  });

  it('expires a callback stage independently of the initiation session', () => {
    const now = Date.parse('2026-08-09T00:00:00.000Z');
    expect(
      isOAuthSessionExpired(
        {
          expiresAt: '2026-08-09T00:09:00.000Z',
          callbackExpiresAt: '2026-08-09T00:01:59.999Z',
        },
        now
      )
    ).toBe(false);
    expect(
      isOAuthSessionExpired(
        {
          expiresAt: '2026-08-09T00:09:00.000Z',
          callbackExpiresAt: '2026-08-08T23:59:59.999Z',
        },
        now
      )
    ).toBe(true);
  });
});
