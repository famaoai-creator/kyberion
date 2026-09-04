/**
 * Persisted cookie jar for the meeting browser driver.
 *
 * A bot that wants to be auto-admitted to Meet (rather than waiting
 * in the lobby) typically logs in once with a Google account and
 * reuses the resulting cookies. We persist them as a JSON file under
 * `active/shared/state/browser-cookies/<account>.json`.
 *
 * The file is read on launch and written on close so the next session
 * resumes the logged-in state. Treat the file like a credential —
 * tier-guard already prevents promotion past `confidential`.
 */

import * as path from 'node:path';
import { isRecord, parseSafeJsonInput } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';

const COOKIE_DIR_REL = 'active/shared/state/browser-cookies';

export interface PersistedBrowserCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitionKey?: string;
}

const COOKIE_KEYS = new Set([
  'name',
  'value',
  'url',
  'domain',
  'path',
  'expires',
  'httpOnly',
  'secure',
  'sameSite',
  'partitionKey',
]);

function parsePersistedCookie(value: unknown): PersistedBrowserCookie | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !COOKIE_KEYS.has(key))) return null;
  const name = value.name;
  const cookieValue = value.value;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof cookieValue !== 'string') return null;
  for (const key of ['url', 'domain', 'path', 'partitionKey']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  }
  if (
    value.expires !== undefined &&
    (typeof value.expires !== 'number' || !Number.isFinite(value.expires))
  ) {
    return null;
  }
  for (const key of ['httpOnly', 'secure']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return null;
  }
  if (
    value.sameSite !== undefined &&
    value.sameSite !== 'Strict' &&
    value.sameSite !== 'Lax' &&
    value.sameSite !== 'None'
  ) {
    return null;
  }
  const cookie: PersistedBrowserCookie = {
    name,
    value: cookieValue,
  };
  if (typeof value.url === 'string') cookie.url = value.url;
  if (typeof value.domain === 'string') cookie.domain = value.domain;
  if (typeof value.path === 'string') cookie.path = value.path;
  if (typeof value.expires === 'number') cookie.expires = value.expires;
  if (typeof value.httpOnly === 'boolean') cookie.httpOnly = value.httpOnly;
  if (typeof value.secure === 'boolean') cookie.secure = value.secure;
  if (value.sameSite === 'Strict' || value.sameSite === 'Lax' || value.sameSite === 'None') {
    cookie.sameSite = value.sameSite;
  }
  if (typeof value.partitionKey === 'string') cookie.partitionKey = value.partitionKey;
  return cookie;
}

export function parsePersistedCookies(value: unknown): PersistedBrowserCookie[] | null {
  if (!Array.isArray(value)) return null;
  const cookies = value.map(parsePersistedCookie);
  return cookies.every((cookie): cookie is PersistedBrowserCookie => cookie !== null)
    ? cookies
    : null;
}

function assertAccountSlug(accountSlug: string): string {
  if (
    !accountSlug ||
    accountSlug === '.' ||
    accountSlug === '..' ||
    accountSlug.includes('/') ||
    accountSlug.includes('\\') ||
    /\p{Cc}/u.test(accountSlug)
  ) {
    throw new Error('[browser-cookie-store] account slug must be a single safe path segment');
  }
  return accountSlug;
}

export function cookiePathFor(accountSlug: string): string {
  const safeAccountSlug = assertAccountSlug(accountSlug);
  const candidate = pathResolver.rootResolve(path.join(COOKIE_DIR_REL, `${safeAccountSlug}.json`));
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

export function readCookies(accountSlug: string): PersistedBrowserCookie[] {
  const file = cookiePathFor(accountSlug);
  if (!safeExistsSync(file) || !safeLstat(file).isFile()) return [];
  try {
    return (
      parsePersistedCookies(
        parseSafeJsonInput(
          String(safeReadFile(file, { encoding: 'utf8' }) || ''),
          `browser cookie store ${file}`
        )
      ) ?? []
    );
  } catch {
    return [];
  }
}

export function writeCookies(accountSlug: string, cookies: unknown[]): void {
  const parsed = parsePersistedCookies(cookies);
  if (!parsed) throw new Error('[browser-cookie-store] cookie payload has an invalid shape');
  const file = cookiePathFor(accountSlug);
  safeMkdir(assertSafeRepositoryPath(path.dirname(file), { allowMissingLeaf: true }), {
    recursive: true,
  });
  safeWriteFile(file, JSON.stringify(parsed, null, 2));
}
