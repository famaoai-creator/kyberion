/**
 * FD-07 item 7 (「どなたですか？」 remote sign-in): a bearer token pasted on
 * `/signin` is kept for the browser session only (`sessionStorage`, cleared
 * when the tab closes) — never `localStorage`, never sent anywhere but this
 * origin's own `/api/*` routes. Loopback never touches this module's state:
 * the rail only calls `attachFrontDeskAuthHeaders` when it already has a
 * token to attach, and the token is only ever set from the `/signin` form.
 */

const TOKEN_STORAGE_KEY = 'front-desk.token';

export function getStoredFrontDeskToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeFrontDeskToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // best-effort only — a token that cannot persist still works for this fetch.
  }
}

export function clearFrontDeskToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // best-effort
  }
}

/** Merge an `Authorization: Bearer <token>` header in, when a token is stored. */
export function attachFrontDeskAuthHeaders(init: HeadersInit = {}): HeadersInit {
  const token = getStoredFrontDeskToken();
  if (!token) return init;
  return { ...init, Authorization: `Bearer ${token}` };
}

/** Loopback never sees `/signin` — this is the client-side half of that rule (the server's half is IP-based). */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
