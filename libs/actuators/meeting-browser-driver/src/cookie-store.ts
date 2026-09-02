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
import { readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';

const COOKIE_DIR_REL = 'active/shared/state/browser-cookies';

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

export function readCookies(accountSlug: string): unknown[] {
  const file = cookiePathFor(accountSlug);
  if (!safeExistsSync(file) || !safeLstat(file).isFile()) return [];
  try {
    const data = readJson<unknown>(file);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function writeCookies(accountSlug: string, cookies: unknown[]): void {
  const file = cookiePathFor(accountSlug);
  safeMkdir(assertSafeRepositoryPath(path.dirname(file), { allowMissingLeaf: true }), {
    recursive: true,
  });
  safeWriteFile(file, JSON.stringify(cookies, null, 2));
}
