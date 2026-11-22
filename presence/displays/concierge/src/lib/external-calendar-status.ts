import { readCalendarProviderAuthStatus } from '@agent/core/meeting/calendar-workflow';

/**
 * Whether the machine's provider login can read a calendar:
 * - `signed_out`: the CLI does not answer, or nothing is stored (`gws auth
 *   status` exits 0 logged out, so `ok` alone is not enough);
 * - `expired`: credentials are stored but the provider refused to refresh
 *   them (`token_refresh_failed`, projected by `readGwsAuthStatus` from
 *   `token_valid: false` with a `token_error`, e.g. `invalid_grant`); the
 *   person has to sign in again;
 * - `signed_in`: otherwise. A status without these fields (another provider)
 *   falls back to its own `ok`.
 */
export type ProviderLoginState = 'signed_in' | 'signed_out' | 'expired';

export function classifyProviderLogin(status: {
  ok?: boolean;
  logged_in?: boolean;
  raw?: unknown;
}): ProviderLoginState {
  if (status.ok !== true || status.logged_in === false) return 'signed_out';
  const raw = status.raw;
  if (!raw || typeof raw !== 'object') return 'signed_in';
  const fields = raw as Record<string, unknown>;
  const known = [
    'encrypted_credentials_exists',
    'plain_credentials_exists',
    'token_cache_exists',
  ].filter((key) => key in fields);
  if (known.length > 0 && !known.some((key) => fields[key] === true)) return 'signed_out';
  if (fields.token_refresh_failed === true) return 'expired';
  return 'signed_in';
}

/**
 * A read failure that is the provider refusing the stored login: an OAuth
 * refusal (`invalid_grant`), an Entra ID sign-in error that needs the person
 * (expired or revoked refresh token, interaction or MFA required), or a 401.
 * Used only to choose `login_expired` over `degraded`; the text itself never
 * leaves the server.
 */
const TOKEN_REFUSAL =
  /invalid_grant|interaction_required|AADSTS(?:70000|700082|700084|70008|70043|50173|50076|50078|50079|50089|50132|50133|65001)\b|refresh token has expired|(?:HTTP|status|code)\W{0,3}401\b|\b401 unauthori[sz]ed|\bunauthori[sz]ed\b(?!_)/iu;

export function isProviderTokenRefusal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return TOKEN_REFUSAL.test(text);
}

/** The status probe runs a CLI synchronously; reuse it briefly instead of on every navigation. */
const STATUS_TTL_MS = 60_000;
const statusCache = new Map<string, { at: number; state: ProviderLoginState }>();

export async function providerLoginState(provider: string): Promise<ProviderLoginState> {
  const hit = statusCache.get(provider);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.state;
  let state: ProviderLoginState = 'signed_out';
  try {
    state = classifyProviderLogin(await readCalendarProviderAuthStatus(provider));
  } catch {
    state = 'signed_out';
  }
  // An expired login is not cached: the page tells the owner to sign in again
  // and reload, so the next view must see the new login at once.
  if (state !== 'expired') statusCache.set(provider, { at: Date.now(), state });
  return state;
}

/** A read failed: check the login again next time instead of trusting the cached answer. */
export function forgetProviderLoginState(provider: string): void {
  statusCache.delete(provider);
}

/** Tests: forget cached provider status. */
export function resetExternalCalendarStatusCache(): void {
  statusCache.clear();
}
