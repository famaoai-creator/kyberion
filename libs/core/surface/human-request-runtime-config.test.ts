import { afterEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../foundation/json.js', () => ({ readJson: io.read }));
import {
  loadHumanRequestRuntimeConfig,
  parseHumanRequestRuntimeConfig,
} from './human-request-runtime-config.js';
const policy = {
  authorityNamespace: 'synthetic',
  tenantSlugs: ['alpha'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['public'],
};
const browser = { enabled: true, operationScopes: ['kyberion:requests:read'] };
const token = {
  issuer: 'https://issuer.example',
  resource: 'https://resource.example/mcp',
  algorithms: ['RS256'],
  jwks: { keys: [{ kty: 'RSA', kid: 'synthetic', n: 'public-n', e: 'AQAB' }] },
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('explicit human request configuration', () => {
  it('defaults both adapters off without reading any file', () => {
    vi.stubEnv('KYBERION_HUMAN_REQUEST_CONFIG', '');
    expect(loadHumanRequestRuntimeConfig()).toEqual({ version: 1 });
    expect(io.read).not.toHaveBeenCalled();
  });
  it('accepts independent browser-only and MCP-only activation documents', () => {
    expect(parseHumanRequestRuntimeConfig({ version: 1, policy, browser }).httpMcp).toBeUndefined();
    expect(
      parseHumanRequestRuntimeConfig({ version: 1, policy, httpMcp: { enabled: true, token } })
        .browser
    ).toBeUndefined();
    expect(
      parseHumanRequestRuntimeConfig({
        version: 1,
        browser: { enabled: false },
        httpMcp: { enabled: false },
      })
    ).toEqual({ version: 1, browser: { enabled: false }, httpMcp: { enabled: false } });
  });
  it('copies trusted policy and rejects login scopes as request grants', () => {
    const source = {
      version: 1,
      policy: structuredClone(policy),
      browser: structuredClone(browser),
    };
    const parsed = parseHumanRequestRuntimeConfig(source);
    source.policy.tenantSlugs.push('beta');
    expect(parsed.policy?.tenantSlugs).toEqual(['alpha']);
    expect(() =>
      parseHumanRequestRuntimeConfig({
        ...source,
        browser: { enabled: true, operationScopes: ['openid', 'email'] },
      })
    ).toThrow('invalid or unavailable');
  });
  it.each([
    null,
    {},
    { version: 2 },
    { version: 1, extra: true },
    { version: 1, browser: { enabled: 'true' } },
    { version: 1, browser },
    { version: 1, policy, browser: { enabled: true } },
    { version: 1, policy, httpMcp: { enabled: true } },
    { version: 1, policy: { ...policy, tierAccess: ['personal'] }, browser },
    { version: 1, policy, browser: { ...browser, client_id: 'no' } },
  ])('rejects malformed or incomplete configuration %#', (value) => {
    expect(() => parseHumanRequestRuntimeConfig(value)).toThrow('invalid or unavailable');
  });
  it.each(['0.0.0.0', 'localhost', '[::1]', '::', '192.0.2.1'])(
    'rejects non-explicit loopback host %s',
    (host) => {
      expect(() =>
        parseHumanRequestRuntimeConfig({
          version: 1,
          policy,
          httpMcp: {
            enabled: true,
            token,
            deployment: { mode: 'loopback-reverse-proxy', host, port: 4100 },
          },
        })
      ).toThrow();
    }
  );
  it.each([0, -1, 65536, 4100.5, '4100'])('rejects invalid listen port %s', (port) => {
    expect(() =>
      parseHumanRequestRuntimeConfig({
        version: 1,
        policy,
        httpMcp: {
          enabled: true,
          token,
          deployment: { mode: 'loopback-reverse-proxy', host: '127.0.0.1', port },
        },
      })
    ).toThrow();
  });
  it('rejects private keys and implicit HTTP fallback even in disabled sections', () => {
    for (const invalid of [
      { ...token, issuer: 'http://localhost' },
      { ...token, resource: 'https://resource.example/' },
      { ...token, jwks: { keys: [{ kty: 'RSA', d: 'private' }] } },
    ]) {
      expect(() =>
        parseHumanRequestRuntimeConfig({ version: 1, httpMcp: { enabled: false, token: invalid } })
      ).toThrow();
    }
  });
  it('does not fall back when a configured file is missing or unreadable', () => {
    for (const message of ['ENOENT /private/config', 'permission denied', 'invalid JSON']) {
      io.read.mockImplementation(() => {
        throw Error(message);
      });
      expect(() => loadHumanRequestRuntimeConfig('explicit-config.json')).toThrow(
        'Human request configuration is invalid or unavailable.'
      );
    }
  });
  it('rereads explicit configuration without caching previous permission', () => {
    io.read
      .mockReturnValueOnce({ version: 1, policy, browser })
      .mockReturnValueOnce({ version: 1, browser: { enabled: false } });
    expect(loadHumanRequestRuntimeConfig('server.json').browser?.enabled).toBe(true);
    expect(loadHumanRequestRuntimeConfig('server.json').browser?.enabled).toBe(false);
    expect(io.read).toHaveBeenCalledTimes(2);
  });
});
