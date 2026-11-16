/**
 * Non-secret network plumbing every isolated provider child still needs
 * behind a corporate proxy / custom CA (a bound child gets ONLY its bound
 * env), from the operator's safe exec env: CA bundle paths and proxy routing.
 * A proxy value carrying userinfo (`user:pass@host`, with or without a
 * scheme) is a credential and is never passed.
 */
import { PROXY_ENV_KEYS } from '../foundation/env.js';
import { buildSafeExecEnv } from '../secure-io.js';

export const PROVIDER_NETWORK_PASSTHROUGH_ENV_KEYS: readonly string[] = [
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  ...PROXY_ENV_KEYS,
];

export function providerNetworkPassthroughEnv(
  source: NodeJS.ProcessEnv = buildSafeExecEnv()
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of PROVIDER_NETWORK_PASSTHROUGH_ENV_KEYS) {
    const value = source[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (/_proxy$/i.test(key) && /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/@\s,]*@/iu.test(value.trim()))
      continue;
    picked[key] = value;
  }
  return picked;
}
