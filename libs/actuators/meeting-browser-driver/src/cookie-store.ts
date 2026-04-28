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
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';

const COOKIE_DIR_REL = 'active/shared/state/browser-cookies';

export function cookiePathFor(accountSlug: string): string {
  return pathResolver.rootResolve(path.join(COOKIE_DIR_REL, `${accountSlug}.json`));
}

export function readCookies(accountSlug: string): unknown[] {
  const file = cookiePathFor(accountSlug);
  if (!safeExistsSync(file)) return [];
  try {
    const data = JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function writeCookies(accountSlug: string, cookies: unknown[]): void {
  const file = cookiePathFor(accountSlug);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(cookies, null, 2));
}
