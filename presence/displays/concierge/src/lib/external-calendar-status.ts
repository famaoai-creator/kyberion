import { readCalendarProviderAuthStatus } from '@agent/core/meeting/calendar-workflow';

/**
 * A provider status says whether its CLI answers, not whether anyone is signed
 * in (`gws auth status` exits 0 logged out). Signed in means stored
 * credentials or a token cache; a status without those fields (another
 * provider) falls back to its own `ok`.
 */
export function isProviderLoggedIn(status: { ok?: boolean; raw?: unknown }): boolean {
  if (status.ok !== true) return false;
  const raw = status.raw;
  if (!raw || typeof raw !== 'object') return true;
  const fields = raw as Record<string, unknown>;
  const known = [
    'encrypted_credentials_exists',
    'plain_credentials_exists',
    'token_cache_exists',
  ].filter((key) => key in fields);
  return known.length === 0 || known.some((key) => fields[key] === true);
}

/** The status probe runs a CLI synchronously; reuse it briefly instead of on every navigation. */
const STATUS_TTL_MS = 60_000;
const statusCache = new Map<string, { at: number; loggedIn: boolean }>();

export async function providerLoggedIn(provider: string): Promise<boolean> {
  const hit = statusCache.get(provider);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.loggedIn;
  let loggedIn = false;
  try {
    loggedIn = isProviderLoggedIn(await readCalendarProviderAuthStatus(provider));
  } catch {
    loggedIn = false;
  }
  statusCache.set(provider, { at: Date.now(), loggedIn });
  return loggedIn;
}

/** Tests: forget cached provider status. */
export function resetExternalCalendarStatusCache(): void {
  statusCache.clear();
}
