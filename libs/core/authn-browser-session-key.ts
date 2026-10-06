/** Shared browser-session key lookup, without authentication-provider registration. */
import { getRegisteredEnvText } from './foundation/env.js';
import { secretGuard } from './secret/secret-guard.js';
import type { AuthnResolveDeps } from './authn-principal-resolver.js';

/** Shortest accepted session key: a short key makes the HMAC forgeable offline. */
export const BROWSER_SESSION_MIN_KEY_BYTES = 32;

/** Sync key lookup shared by the signer (login callback) and the verifier. */
export function browserSessionKey(deps?: AuthnResolveDeps): Buffer | null {
  // A weak key is treated as "not configured" rather than silently accepted.
  const strong = (value: string | undefined): Buffer | null =>
    value && Buffer.byteLength(value, 'utf8') >= BROWSER_SESSION_MIN_KEY_BYTES
      ? Buffer.from(value, 'utf8')
      : null;
  const envKey = getRegisteredEnvText(
    'KYBERION_SESSION_SECRET',
    deps?.env ? { env: deps.env } : undefined
  )?.trim();
  if (envKey) return strong(envKey);
  try {
    const doc = secretGuard.loadConnectionDocument('kyberion-browser-session') as
      { hmac_key?: string } | undefined;
    return strong(doc?.hmac_key?.trim());
  } catch {
    return null;
  }
}
