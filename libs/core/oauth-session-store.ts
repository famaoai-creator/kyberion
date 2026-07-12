import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeFsyncFile,
  safeMkdir,
  safeReadFile,
  safeReaddir,
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
}

export const OAUTH_SESSION_ROOT = pathResolver.sharedTmp('oauth');

export function serviceSessionDir(serviceId: string): string {
  return path.join(OAUTH_SESSION_ROOT, serviceId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
}

export function serviceSessionPath(serviceId: string, state: string): string {
  return path.join(serviceSessionDir(serviceId), `${state}.json`);
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
      return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
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
    return JSON.parse(safeReadFile(path.join(dir, files[0]), { encoding: 'utf8' }) as string);
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
  if (!safeExistsSync(OAUTH_SESSION_ROOT)) return [];
  const sessions: PendingOAuthSession[] = [];
  try {
    for (const serviceDir of safeReaddir(OAUTH_SESSION_ROOT)) {
      const fullDir = path.join(OAUTH_SESSION_ROOT, serviceDir);
      if (!safeExistsSync(fullDir)) continue;
      for (const fileName of safeReaddir(fullDir)) {
        if (!fileName.endsWith('.json')) continue;
        try {
          const session = JSON.parse(
            safeReadFile(path.join(fullDir, fileName), { encoding: 'utf8' }) as string
          ) as PendingOAuthSession;
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
  return listPendingOAuthSessions().find((session) => session.state === state) || null;
}
