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
  savePendingOAuthSession,
  readOAuthOperation,
  finishOAuthOperation,
  isSafeOAuthState,
  acquirePendingOAuthCallback,
  listPendingOAuthSessions,
  loadPendingOAuthSession,
  serviceSessionDir,
  serviceSessionLockPath,
  serviceSessionPath,
} from './oauth-session-store.js';

describe('oauth session hygiene', () => {
  it('binds operation observation to its initiating principal and removes secrets at completion', () => {
    const serviceId = 'oauth-operation-receipt-test';
    const now = Date.now();
    const session = {
      serviceId,
      state: 'secret_state_1234',
      operationId: 'public_operation_1234',
      observerPrincipalId: 'operator-a',
      scopes: ['read'],
      codeVerifier: 'synthetic-verifier',
      redirectUri: 'http://127.0.0.1/callback',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    try {
      savePendingOAuthSession(session);
      expect(readOAuthOperation(serviceId, session.operationId, 'operator-b', now)).toBeNull();
      expect(readOAuthOperation(serviceId, session.operationId, 'operator-a', now)).toMatchObject({
        status: 'waiting',
      });
      finishOAuthOperation(session, 'connected', now + 1);
      expect(safeExistsSync(serviceSessionPath(serviceId, session.state))).toBe(false);
      const receipt = String(
        safeReadFile(serviceSessionPath(serviceId, session.operationId), { encoding: 'utf8' })
      );
      for (const secret of [
        'synthetic-verifier',
        'secret_state_1234',
        'redirectUri',
        'codeVerifier',
      ])
        expect(receipt).not.toContain(secret);
      expect(readOAuthOperation(serviceId, session.operationId, 'operator-a', now + 2)).toEqual({
        operationId: session.operationId,
        serviceId,
        status: 'connected',
        expiresAt: new Date(now + 1 + 300_000).toISOString(),
      });
      expect(acquirePendingOAuthCallback(serviceId, session.operationId, now + 2)).toBeNull();
      expect(
        readOAuthOperation(serviceId, session.operationId, 'operator-a', now + 300_002)
      ).toBeNull();
      expect(safeExistsSync(serviceSessionPath(serviceId, session.operationId))).toBe(false);
    } finally {
      safeRmSync(serviceSessionDir(serviceId), { recursive: true, force: true });
    }
  });

  it('clears secret-bearing pending state even when receipt publication fails validation', () => {
    const serviceId = 'oauth-operation-publication-failure';
    const now = Date.now();
    const session = {
      serviceId,
      state: 'state_before_failure',
      operationId: 'operation_before_failure',
      observerPrincipalId: 'operator-a',
      scopes: [],
      codeVerifier: 'synthetic-verifier',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 1000).toISOString(),
    };
    try {
      savePendingOAuthSession(session);
      expect(() =>
        finishOAuthOperation({ ...session, operationId: '../invalid' }, 'connected', now)
      ).toThrow();
      expect(safeExistsSync(serviceSessionPath(serviceId, session.state))).toBe(false);
      expect(readOAuthOperation(serviceId, session.operationId, 'operator-a', now)).toBeNull();
    } finally {
      safeRmSync(serviceSessionDir(serviceId), { recursive: true, force: true });
    }
  });

  it('keeps callback progress and failed/expired attempts distinct without guessing success', () => {
    const serviceId = 'oauth-operation-expiry-test';
    const now = Date.now();
    const session = {
      serviceId,
      state: 'secret_state_2345',
      operationId: 'operation_expiry_2345',
      observerPrincipalId: 'operator-a',
      scopes: [],
      codeVerifier: 'verifier',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 1000).toISOString(),
      callbackStartedAt: new Date(now).toISOString(),
      callbackExpiresAt: new Date(now + 500).toISOString(),
    };
    try {
      savePendingOAuthSession(session);
      expect(readOAuthOperation(serviceId, session.operationId, 'operator-a', now)).toMatchObject({
        status: 'confirming',
      });
      expect(
        readOAuthOperation(serviceId, session.operationId, 'operator-a', now + 501)
      ).toMatchObject({ status: 'expired' });
      expect(safeExistsSync(serviceSessionPath(serviceId, session.state))).toBe(false);
      finishOAuthOperation(session, 'connected', now + 501);
      expect(
        readOAuthOperation(serviceId, session.operationId, 'operator-a', now + 502)
      ).toMatchObject({ status: 'expired' });
      expect(readOAuthOperation(serviceId, 'missing_operation', 'operator-a', now)).toBeNull();
    } finally {
      safeRmSync(serviceSessionDir(serviceId), { recursive: true, force: true });
    }
  });

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

  it('keeps ordinary pending session lookup compatible with completed operation receipts', () => {
    const serviceId = 'oauth-session-receipt-lookup-test';
    const now = Date.now();
    const base = {
      serviceId,
      scopes: [],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    const observed = {
      ...base,
      state: 'tracked_state_1234',
      operationId: 'zzzz_operation_1234',
      observerPrincipalId: 'operator-a',
    };
    try {
      savePendingOAuthSession({ ...base, state: 'AAAA_pending_1234' });
      savePendingOAuthSession(observed);
      finishOAuthOperation(observed, 'connected', now);
      expect(loadPendingOAuthSession(serviceId)?.state).toBe('AAAA_pending_1234');
      expect(
        listPendingOAuthSessions().filter((session) => session.serviceId === serviceId)
      ).toHaveLength(1);
    } finally {
      safeRmSync(serviceSessionDir(serviceId), { recursive: true, force: true });
    }
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

  it('fails closed when the callback lock path is replaced by a directory', () => {
    const serviceId = 'oauth-callback-lock-directory-test';
    const state = 'D'.repeat(32);
    const lockPath = serviceSessionLockPath(serviceId, state);
    safeMkdir(serviceSessionDir(serviceId), { recursive: true });
    safeMkdir(lockPath, { recursive: true });
    try {
      expect(acquirePendingOAuthCallback(serviceId, state)).toBeNull();
    } finally {
      safeRmSync(lockPath, { recursive: true, force: true });
    }
  });
});
