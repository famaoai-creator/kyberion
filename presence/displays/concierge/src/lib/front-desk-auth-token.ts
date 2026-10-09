/**
 * The signed-in member's bearer stays in this tab's sessionStorage. It is
 * attached explicitly to member API calls, never to local-operator APIs.
 * No rejected credential is cleared automatically: that could silently fall
 * back to the broader credential-free loopback identity.
 */

let authRevision = 0;
let storageFailed = false;
export function getFrontDeskAuthRevision(): number {
  return authRevision;
}

const TOKEN_STORAGE_KEY = 'front-desk.token';
/**
 * UX-only hint so the page-navigation middleware does not bounce a pasted-token
 * user to /login (it cannot see sessionStorage). Grants nothing: API routes
 * still verify the real token.
 */
const TOKEN_HINT_COOKIE = 'kyberion_client_token';

function setTokenHintCookie(present: boolean): void {
  try {
    document.cookie = present
      ? `${TOKEN_HINT_COOKIE}=1; Path=/; SameSite=Lax`
      : `${TOKEN_HINT_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
  } catch {
    // best-effort
  }
}

export function getStoredFrontDeskToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeFrontDeskToken(token: string): boolean {
  authRevision++;
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    if (window.sessionStorage.getItem(TOKEN_STORAGE_KEY) !== token)
      throw new Error('Credential storage unavailable');
    storageFailed = false;
    setTokenHintCookie(true);
    return true;
  } catch {
    storageFailed = true;
    return false;
  }
}

export function clearFrontDeskToken(): boolean {
  authRevision++;
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    if (window.sessionStorage.getItem(TOKEN_STORAGE_KEY) !== null) return false;
  } catch {
    return false;
  }
  storageFailed = false;
  setTokenHintCookie(false);
  return true;
}

/** Network callers fail closed when browser storage is inaccessible or a save failed. */
export function readFrontDeskRequestToken(): string | null {
  if (storageFailed) throw new Error('Credential storage unavailable');
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    throw new Error('Credential storage unavailable');
  }
}

/** Merge an `Authorization: Bearer <token>` header in, when a token is stored. */
export function attachFrontDeskAuthHeaders(init: HeadersInit = {}): HeadersInit {
  const headers = new Headers(init);
  const token = getStoredFrontDeskToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/** Credential-free loopback can use local-operator mode; rejected bearer sessions still require sign-in. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
