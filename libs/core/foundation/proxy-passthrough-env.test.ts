import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildProxyPassthroughEnv,
  LOOPBACK_NO_PROXY_HOSTS,
  PROXY_ENV_KEYS,
  safeChildEnv,
  withLoopbackNoProxy,
} from './env.js';
import { buildSafeExecEnv } from '../secure-io.js';
import { sanitizeEnvForChild } from '../mesh/acp-mediator.js';
import { buildProviderChildEnv } from '../provider/provider-permission-profiles.js';
import { withLoopbackNoProxy as relayWithLoopbackNoProxy } from '../provider/provider-credential-relay.js';

const LOOPBACK = LOOPBACK_NO_PROXY_HOSTS.join(',');
const PROXIED = {
  PATH: '/bin',
  HOME: '/home/test',
  HTTPS_PROXY: 'http://proxy.corp.example:3128',
  NO_PROXY: 'corp.example',
} as const;

afterEach(() => vi.unstubAllEnvs());

describe('buildProxyPassthroughEnv', () => {
  it('appends loopback to NO_PROXY and no_proxy whenever a proxy URL is passed', () => {
    expect(buildProxyPassthroughEnv({ https_proxy: 'http://p:1', NO_PROXY: 'a.example' })).toEqual({
      https_proxy: 'http://p:1',
      NO_PROXY: `a.example,${LOOPBACK}`,
      no_proxy: LOOPBACK,
    });
  });

  it('dedupes case-insensitively and keeps existing entries', () => {
    const env = buildProxyPassthroughEnv({
      HTTP_PROXY: 'http://p:1',
      NO_PROXY: 'LOCALHOST, a.example',
      no_proxy: '127.0.0.1',
    });
    expect(env.NO_PROXY).toBe('LOCALHOST,a.example,127.0.0.1,::1');
    expect(env.no_proxy).toBe('127.0.0.1,localhost,::1');
    expect(buildProxyPassthroughEnv(env)).toEqual(env);
  });

  it('passes only proxy keys, and NO_PROXY unchanged when no proxy URL is set', () => {
    expect(
      buildProxyPassthroughEnv({ PATH: '/bin', NO_PROXY: 'a.example', HTTPS_PROXY: '' })
    ).toEqual({ NO_PROXY: 'a.example' });
    expect(buildProxyPassthroughEnv({ PATH: '/bin' })).toEqual({});
    expect(PROXY_ENV_KEYS).toContain('no_proxy');
  });

  it('withLoopbackNoProxy is shared with the credential relay re-export', () => {
    expect(relayWithLoopbackNoProxy).toBe(withLoopbackNoProxy);
  });
});

describe('child-env allowlists pass proxies only through the loopback guard', () => {
  const expectGuarded = (env: Record<string, string | undefined>) => {
    expect(env.HTTPS_PROXY).toBe(PROXIED.HTTPS_PROXY);
    expect(env.NO_PROXY).toBe(`corp.example,${LOOPBACK}`);
    expect(env.no_proxy).toBe(LOOPBACK);
  };

  it('secure-io buildSafeExecEnv', () => {
    for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, '');
    vi.stubEnv('HTTPS_PROXY', PROXIED.HTTPS_PROXY);
    vi.stubEnv('NO_PROXY', PROXIED.NO_PROXY);
    expectGuarded(buildSafeExecEnv());
  });

  it('secure-io buildSafeExecEnv guards a proxy passed as an explicit override', () => {
    for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, '');
    const env = buildSafeExecEnv({ HTTPS_PROXY: PROXIED.HTTPS_PROXY, NO_PROXY: 'corp.example' });
    expectGuarded(env);
  });

  it('provider child env (buildProviderChildEnv)', () => {
    expectGuarded(buildProviderChildEnv({ provider: 'claude', baseEnv: { ...PROXIED } }));
  });

  it('ACP mediator child env (sanitizeEnvForChild)', () => {
    expectGuarded(sanitizeEnvForChild({ ...PROXIED } as NodeJS.ProcessEnv));
  });

  it('foundation safeChildEnv', () => {
    expectGuarded(safeChildEnv({ ...PROXIED }));
  });

  it('no proxy ⇒ no loopback NO_PROXY is invented', () => {
    const env = safeChildEnv({ PATH: '/bin' });
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });
});
