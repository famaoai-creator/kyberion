/** Shared browser-session key lookup, without authentication-provider registration. */
import { withExecutionContext } from './authority.js';
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
    // Connection documents live under the personal tier: surfaces call this
    // from unauthenticated login routes, outside any execution context.
    // System scope (tenant cleared), like the chronos token registry reader:
    // the session key is operator-wide, and a persisted tenant binding would
    // otherwise deny the read and break sign-in on every surface.
    const doc = withExecutionContext(
      'sovereign_concierge',
      () =>
        secretGuard.loadConnectionDocument('kyberion-browser-session') as
          { hmac_key?: string } | undefined,
      undefined,
      ''
    );
    return strong(doc?.hmac_key?.trim());
  } catch {
    return null;
  }
}
