import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeCreateExclusiveFileSync,
  safeFsyncFile,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeLstat,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { createLogger } from './logger.js';
const logger = createLogger('oauth-session-store');

export interface PendingOAuthSession {
  serviceId: string;
  state: string;
  codeVerifier?: string;
  redirectUri?: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  callbackStartedAt?: string;
  callbackExpiresAt?: string;
}

export const OAUTH_SESSION_ROOT = pathResolver.sharedTmp('oauth');
export const OAUTH_INITIATION_TTL_MS = 10 * 60 * 1000;
export const OAUTH_CALLBACK_TTL_MS = 2 * 60 * 1000;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

export function isSafeOAuthState(state: string): boolean {
  return OAUTH_STATE_PATTERN.test(state);
}

export function assertSafeOAuthState(state: string): void {
  if (!isSafeOAuthState(state)) {
    throw new Error('OAuth state must be a safe token');
  }
}

function statesEqual(left: string, right: string): boolean {
  if (!isSafeOAuthState(left) || !isSafeOAuthState(right)) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function serviceSessionDir(serviceId: string): string {
  const normalized = serviceId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return assertSafeRepositoryPath(path.join(OAUTH_SESSION_ROOT, normalized), {
    allowMissingLeaf: true,
  });
}

export function serviceSessionPath(serviceId: string, state: string): string {
  assertSafeOAuthState(state);
  return assertSafeRepositoryPath(path.join(serviceSessionDir(serviceId), `${state}.json`), {
    allowMissingLeaf: true,
  });
}

export function serviceSessionLockPath(serviceId: string, state: string): string {
  assertSafeOAuthState(state);
  return assertSafeRepositoryPath(
    path.join(serviceSessionDir(serviceId), `.${state}.callback.lock`),
    { allowMissingLeaf: true }
  );
}

export function randomUrlSafe(length = 48): string {
  return crypto.randomBytes(length).toString('base64url');
}

export function buildCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

export function savePendingOAuthSession(session: PendingOAuthSession): void {
  const dir = serviceSessionDir(session.serviceId);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
  const filePath = serviceSessionPath(session.serviceId, session.state);
  safeWriteFile(filePath, JSON.stringify(session, null, 2) + '\n');
  try {
    safeFsyncFile(filePath);
  } catch (err) {
    logger.warn(`suppressed error in savePendingOAuthSession: ${err}`);
  }
}

export function loadPendingOAuthSession(
  serviceId: string,
  state?: string
): PendingOAuthSession | null {
  const dir = serviceSessionDir(serviceId);
  if (!safeExistsSync(dir)) return null;

  if (state) {
    const filePath = serviceSessionPath(serviceId, state);
    if (!safeExistsSync(filePath)) return null;
    try {
      const session = readJson<PendingOAuthSession>(filePath);
      if (session.serviceId !== serviceId || !statesEqual(session.state, state)) {
        clearPendingOAuthSession(serviceId, state);
        return null;
      }
      if (isOAuthSessionExpired(session)) {
        clearPendingOAuthSession(serviceId, session.state);
        return null;
      }
      return session;
    } catch (_) {
      return null;
    }
  }

  try {
    const files = safeReaddir(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const filePath = assertSafeRepositoryPath(path.join(dir, files[0]));
    if (!safeLstat(filePath).isFile()) return null;
    const session = readJson<PendingOAuthSession>(filePath);
    if (isOAuthSessionExpired(session)) {
      clearPendingOAuthSession(serviceId, session.state);
      return null;
    }
    return session;
  } catch (_) {
    return null;
  }
}

export function clearPendingOAuthSession(serviceId: string, state: string): void {
  const filePath = serviceSessionPath(serviceId, state);
  if (safeExistsSync(filePath)) {
    safeUnlinkSync(filePath);
  }
}

export function listPendingOAuthSessions(): PendingOAuthSession[] {
  let sessionRoot: string;
  try {
    sessionRoot = assertSafeRepositoryPath(OAUTH_SESSION_ROOT, { allowMissingLeaf: true });
  } catch {
    return [];
  }
  if (!safeExistsSync(sessionRoot)) return [];
  const sessions: PendingOAuthSession[] = [];
  try {
    for (const serviceDir of safeReaddir(sessionRoot)) {
      let fullDir: string;
      try {
        fullDir = assertSafeRepositoryPath(path.join(sessionRoot, serviceDir), {
          allowMissingLeaf: true,
        });
      } catch {
        continue;
      }
      if (!safeExistsSync(fullDir)) continue;
      for (const fileName of safeReaddir(fullDir)) {
        if (!fileName.endsWith('.json')) continue;
        try {
          const filePath = assertSafeRepositoryPath(path.join(fullDir, fileName), {
            allowMissingLeaf: true,
          });
          const session = readJson<PendingOAuthSession>(filePath);
          if (!isSafeOAuthState(session.state)) {
            continue;
          }
          if (isOAuthSessionExpired(session)) {
            clearPendingOAuthSession(session.serviceId, session.state);
            continue;
          }
          sessions.push(session);
        } catch (err) {
          logger.warn(`suppressed error in listPendingOAuthSessions: ${err}`);
        }
      }
    }
  } catch (err) {
    logger.warn(`suppressed error in listPendingOAuthSessions: ${err}`);
  }
  return sessions;
}

export function normalizeScopes(scopes?: string[] | string): string[] {
  if (!scopes) return [];
  if (Array.isArray(scopes)) return scopes.filter(Boolean);
  return scopes
    .split(/[ ,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function findPendingOAuthSessionByState(state: string): PendingOAuthSession | null {
  if (!state) return null;
  assertSafeOAuthState(state);
  const candidate = Buffer.from(state);
  return (
    listPendingOAuthSessions().find((session) => {
      const actual = Buffer.from(session.state);
      return actual.length === candidate.length && crypto.timingSafeEqual(actual, candidate);
    }) || null
  );
}

export function isOAuthSessionExpired(
  session: Pick<PendingOAuthSession, 'expiresAt' | 'callbackExpiresAt'>,
  now = Date.now()
): boolean {
  // Sessions created before expiry metadata was introduced are not safe to
  // resume: discard them rather than turning a migration gap into an
  // indefinite OAuth grant.
  if (!session.expiresAt) return true;
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return true;
  if (!session.callbackExpiresAt) return false;
  const callbackExpiresAt = Date.parse(session.callbackExpiresAt);
  return !Number.isFinite(callbackExpiresAt) || callbackExpiresAt <= now;
}

export function acquirePendingOAuthCallback(
  serviceId: string,
  state: string,
  now = Date.now()
): { session: PendingOAuthSession; release: () => void } | null {
  const lockPath = serviceSessionLockPath(serviceId, state);
  let lockCreated = false;
  try {
    safeCreateExclusiveFileSync(lockPath, `${process.pid}:${now}\n`);
    lockCreated = true;
  } catch (error) {
    if (!safeExistsSync(lockPath)) throw error;
    try {
      const lockContents = String(safeReadFile(lockPath, { encoding: 'utf8' }));
      const lockCreatedAt = Number(lockContents.trim().split(':').at(-1));
      if (!Number.isFinite(lockCreatedAt) || now - lockCreatedAt <= OAUTH_CALLBACK_TTL_MS) {
        return null;
      }
      safeUnlinkSync(lockPath);
      safeCreateExclusiveFileSync(lockPath, `${process.pid}:${now}\n`);
      lockCreated = true;
    } catch {
      return null;
    }
  }

  if (!lockCreated) return null;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (safeExistsSync(lockPath)) safeUnlinkSync(lockPath);
  };

  const session = loadPendingOAuthSession(serviceId, state);
  if (!session) {
    release();
    return null;
  }

  const startedAt = new Date(now).toISOString();
  const updated: PendingOAuthSession = {
    ...session,
    callbackStartedAt: startedAt,
    callbackExpiresAt: new Date(now + OAUTH_CALLBACK_TTL_MS).toISOString(),
  };
  try {
    savePendingOAuthSession(updated);
    return { session: updated, release };
  } catch (error) {
    release();
    throw error;
  }
}
