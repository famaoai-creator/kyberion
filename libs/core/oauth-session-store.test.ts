import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  isOAuthSessionExpired,
  isSafeOAuthState,
  listPendingOAuthSessions,
  loadPendingOAuthSession,
  serviceSessionDir,
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

  it('fails closed for malformed or filename-mismatched persisted sessions', () => {
    const serviceId = 'oauth-session-parser-test';
    const state = 'A'.repeat(32);
    const filePath = serviceSessionPath(serviceId, state);
    safeMkdir(serviceSessionDir(serviceId), { recursive: true });
    try {
      safeWriteFile(
        filePath,
        JSON.stringify({
          serviceId,
          state,
          scopes: ['profile'],
          createdAt: '2026-08-09T00:00:00.000Z',
          expiresAt: '2026-08-09T00:10:00.000Z',
          constructor: 'must be rejected',
        })
      );
      expect(loadPendingOAuthSession(serviceId, state)).toBeNull();

      safeWriteFile(
        filePath,
        JSON.stringify({
          serviceId,
          state: 'B'.repeat(32),
          scopes: ['profile'],
          createdAt: '2026-08-09T00:00:00.000Z',
          expiresAt: '2026-08-09T00:10:00.000Z',
        })
      );
      expect(loadPendingOAuthSession(serviceId, state)).toBeNull();
      expect(listPendingOAuthSessions()).not.toContainEqual(
        expect.objectContaining({ serviceId, state: 'B'.repeat(32) })
      );
    } finally {
      if (safeExistsSync(filePath)) safeUnlinkSync(filePath);
    }
  });

  it('revalidates the latest-session file selected from the service directory', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/oauth-session-store.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain(
      'const filePath = assertSafeRepositoryPath(path.join(dir, files[0]));'
    );
    expect(source).toContain('if (!safeLstat(filePath).isFile()) return null;');
  });

  it('ignores a directory in the session directory instead of reading it as JSON', () => {
    const serviceId = 'oauth-session-directory-test';
    const state = 'C'.repeat(32);
    const filePath = serviceSessionPath(serviceId, state);
    safeMkdir(serviceSessionDir(serviceId), { recursive: true });
    safeMkdir(filePath, { recursive: true });
    try {
      expect(loadPendingOAuthSession(serviceId, state)).toBeNull();
      expect(listPendingOAuthSessions()).not.toContainEqual(
        expect.objectContaining({ serviceId, state })
      );
    } finally {
      safeRmSync(filePath, { recursive: true, force: true });
    }
  });
});
