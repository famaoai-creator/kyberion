import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vcs/session-git-index.js', () => ({ prepareSessionGitIndex: vi.fn(() => null) }));

import { logger } from '../core.js';
import {
  CREDENTIAL_RELAY_PLACEHOLDER_PREFIX,
  agentSupportsProxyEnv,
  applyProviderCredentialRelay,
  resetCredentialRelayProxyWarningForTests,
  prepareProviderCredentialRelay,
  startCredentialRelay,
  withLoopbackNoProxy,
  type CredentialRelayHandle,
} from './provider-credential-relay.js';
import { buildDelegationSpawnEnv, buildDelegationSpawnEnvWithRelay } from './provider-spawn-env.js';

const REAL_ANTHROPIC = 'sk-ant-real-relay-key-0123456789';
const REAL_OPENAI = 'sk-openai-real-relay-key-0123456789';

interface SeenRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let upstream: http.Server;
let upstreamUrl: string;
let seen: SeenRequest[];
const relays: CredentialRelayHandle[] = [];

beforeEach(async () => {
  seen = [];
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 5);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function track(relay: CredentialRelayHandle): CredentialRelayHandle {
  relays.push(relay);
  return relay;
}

async function call(
  url: string,
  headers: Record<string, string>,
  body = '{"q":1}'
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { method: 'POST', headers, body });
  return { status: response.status, text: await response.text() };
}

describe('startCredentialRelay', () => {
  it('swaps the placeholder for the real key and streams the upstream response', async () => {
    const relay = track(
      await startCredentialRelay({
        protocol: 'anthropic',
        credential: REAL_ANTHROPIC,
        upstream: upstreamUrl,
      })
    );
    expect(relay.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(relay.placeholder.startsWith(CREDENTIAL_RELAY_PLACEHOLDER_PREFIX)).toBe(true);

    const result = await call(`${relay.baseUrl}/v1/messages?beta=true`, {
      'x-api-key': relay.placeholder,
      'content-type': 'application/json',
    });
    expect(result).toEqual({ status: 200, text: 'data: one\n\ndata: two\n\n' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/v1/messages?beta=true');
    expect(seen[0].headers['x-api-key']).toBe(REAL_ANTHROPIC);
    expect(seen[0].body).toBe('{"q":1}');
    expect(JSON.stringify(seen[0].headers)).not.toContain(relay.placeholder);
  });

  it('uses Authorization: Bearer for OpenAI-compatible upstreams and keeps the base path', async () => {
    const relay = track(
      await startCredentialRelay({
        protocol: 'openai',
        credential: REAL_OPENAI,
        upstream: `${upstreamUrl}/v1`,
      })
    );
    expect(relay.baseUrl.endsWith('/v1')).toBe(true);
    const ok = await call(`${relay.baseUrl}/responses`, {
      authorization: `Bearer ${relay.placeholder}`,
    });
    expect(ok.status).toBe(200);
    expect(seen[0].headers.authorization).toBe(`Bearer ${REAL_OPENAI}`);

    const outside = await call(`${relay.baseUrl.replace(/\/v1$/u, '')}/admin`, {
      authorization: `Bearer ${relay.placeholder}`,
    });
    expect(outside.status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it('rejects a wrong, missing or real-key credential without contacting upstream', async () => {
    const relay = track(
      await startCredentialRelay({
        protocol: 'anthropic',
        credential: REAL_ANTHROPIC,
        upstream: upstreamUrl,
      })
    );
    const wrong = await call(`${relay.baseUrl}/v1/messages`, {
      'x-api-key': `${CREDENTIAL_RELAY_PLACEHOLDER_PREFIX}not-the-current-turn`,
    });
    const missing = await call(`${relay.baseUrl}/v1/messages`, {});
    const other = track(
      await startCredentialRelay({
        protocol: 'anthropic',
        credential: REAL_ANTHROPIC,
        upstream: upstreamUrl,
      })
    );
    const otherTurn = await call(`${relay.baseUrl}/v1/messages`, {
      'x-api-key': other.placeholder,
    });
    expect([wrong.status, missing.status, otherTurn.status]).toEqual([401, 401, 401]);
    expect(wrong.text).not.toContain(REAL_ANTHROPIC);
    expect(seen).toHaveLength(0);
  });

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const relay = track(
      await startCredentialRelay({
        protocol: 'anthropic',
        credential: REAL_ANTHROPIC,
        upstream: upstreamUrl,
      })
    );
    const { port } = new URL(relay.baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: Number(port),
          method: 'POST',
          path: '/v1/messages',
          headers: { host: `evil.example:${port}`, 'x-api-key': relay.placeholder },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
    expect(seen).toHaveLength(0);
  });

  it('strips headers named in the Connection header before forwarding', async () => {
    const relay = track(
      await startCredentialRelay({
        protocol: 'anthropic',
        credential: REAL_ANTHROPIC,
        upstream: upstreamUrl,
      })
    );
    const { port } = new URL(relay.baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: Number(port),
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'x-api-key': relay.placeholder,
            connection: 'keep-alive, x-hop-only',
            'x-hop-only': 'must-not-forward',
            'x-end-to-end': 'kept',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(200);
    expect(seen[0].headers['x-hop-only']).toBeUndefined();
    expect(seen[0].headers['x-end-to-end']).toBe('kept');
  });

  it('refuses a plain-http non-loopback upstream', async () => {
    await expect(
      startCredentialRelay({
        protocol: 'openai',
        credential: REAL_OPENAI,
        upstream: 'http://api.example.com/v1',
      })
    ).rejects.toThrow('[CREDENTIAL_RELAY_UPSTREAM_INVALID]');
  });

  it('routes a non-loopback upstream hop through HTTPS_PROXY (CONNECT)', async () => {
    const connects: string[] = [];
    const proxy = http.createServer((_req, res) => res.writeHead(405).end());
    proxy.on('connect', (req, socket) => {
      connects.push(req.url ?? '');
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    // The guard checks the request's logical host; the socket only reaches the local proxy.
    vi.stubEnv('KYBERION_VITEST_NETWORK_ALLOWLIST', 'api.relay-proxy.invalid:443');
    try {
      const relay = track(
        await startCredentialRelay({
          protocol: 'anthropic',
          credential: REAL_ANTHROPIC,
          upstream: 'https://api.relay-proxy.invalid',
          proxyEnv: {
            HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
          },
        })
      );
      const result = await call(`${relay.baseUrl}/v1/messages`, {
        'x-api-key': relay.placeholder,
      });
      expect(result.status).toBe(502);
      expect(connects).toEqual(['api.relay-proxy.invalid:443']);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('warns once (what — why | next) when the runtime agent ignores proxyEnv and a proxy is set', async () => {
    resetCredentialRelayProxyWarningForTests();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const start = (proxyEnv: NodeJS.ProcessEnv) =>
        startCredentialRelay({
          protocol: 'anthropic',
          credential: REAL_ANTHROPIC,
          upstream: 'https://api.relay-proxy.invalid',
          proxyEnv,
          proxyEnvSupported: false,
        }).then(track);
      await start({});
      expect(warn).not.toHaveBeenCalled();
      await start({ HTTPS_PROXY: 'http://proxy.corp.example:3128' });
      await start({ https_proxy: 'http://proxy.corp.example:3128' });
      const relayWarnings = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('ignores proxyEnv'));
      expect(relayWarnings).toHaveLength(1);
      expect(relayWarnings[0]).toMatch(/ — .* \| next: .* \| evidence: node=/);
    } finally {
      warn.mockRestore();
      resetCredentialRelayProxyWarningForTests();
    }
  });

  it('does not warn when the agent honors proxyEnv', async () => {
    resetCredentialRelayProxyWarningForTests();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      track(
        await startCredentialRelay({
          protocol: 'anthropic',
          credential: REAL_ANTHROPIC,
          upstream: 'https://api.relay-proxy.invalid',
          proxyEnv: { HTTPS_PROXY: 'http://proxy.corp.example:3128' },
          proxyEnvSupported: true,
        })
      );
      expect(warn.mock.calls.some(([m]) => String(m).includes('ignores proxyEnv'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('agentSupportsProxyEnv detects an agent that silently ignores proxyEnv', () => {
    class IgnoringAgent {
      constructor(_options: unknown) {}
    }
    expect(agentSupportsProxyEnv(IgnoringAgent, '24.4.1')).toBe(false);
    expect(agentSupportsProxyEnv(IgnoringAgent, '24.5.0')).toBe(true);
    expect(agentSupportsProxyEnv(IgnoringAgent, '25.0.0')).toBe(true);
    // This runtime (engines: node >= 24) — probe agrees with the real agent.
    expect(typeof agentSupportsProxyEnv()).toBe('boolean');
  });

  it('aborts the upstream forward when the client disconnects mid-stream', async () => {
    let upstreamClosed = false;
    const hanging = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      // Never ends: only a client-side abort can release it.
      res.once('close', () => {
        upstreamClosed = true;
      });
    });
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    try {
      const relay = track(
        await startCredentialRelay({
          protocol: 'anthropic',
          credential: REAL_ANTHROPIC,
          upstream: `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`,
        })
      );
      const controller = new AbortController();
      const response = await fetch(`${relay.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': relay.placeholder },
        body: '{}',
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 2000 });
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it('stops serving after teardown', async () => {
    const relay = await startCredentialRelay({
      protocol: 'anthropic',
      credential: REAL_ANTHROPIC,
      upstream: upstreamUrl,
    });
    relay.close();
    relay.close();
    expect(relay.closed).toBe(true);
    await expect(
      call(`${relay.baseUrl}/v1/messages`, { 'x-api-key': relay.placeholder })
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('relay integration in the delegation spawn env', () => {
  const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({
      PATH: '/usr/bin:/bin',
      HOME: '/home/test',
      ANTHROPIC_API_KEY: REAL_ANTHROPIC,
      OPENAI_API_KEY: REAL_OPENAI,
      KYBERION_DELEGATION_DEPTH: '0',
      ...extra,
    }) as NodeJS.ProcessEnv;

  it('is off by default: the child env is unchanged', async () => {
    const spawnEnv = await buildDelegationSpawnEnvWithRelay({
      provider: 'claude',
      sessionId: 's',
      baseEnv: baseEnv(),
    });
    expect(spawnEnv.env.ANTHROPIC_API_KEY).toBe(REAL_ANTHROPIC);
    expect(spawnEnv.env.ANTHROPIC_BASE_URL).toBeUndefined();
    spawnEnv.dispose();
  });

  it('when enabled, the real key never reaches the child env and dispose tears the relay down', async () => {
    const spawnEnv = await buildDelegationSpawnEnvWithRelay({
      provider: 'claude',
      sessionId: 's',
      baseEnv: baseEnv({
        KYBERION_PROVIDER_CREDENTIAL_RELAY: '1',
        ANTHROPIC_BASE_URL: upstreamUrl,
        HTTPS_PROXY: 'http://proxy.corp.example:3128',
        NO_PROXY: 'corp.example',
      }),
    });
    const childEnv = spawnEnv.env;
    expect(JSON.stringify(childEnv)).not.toContain(REAL_ANTHROPIC);
    expect(JSON.stringify(childEnv)).not.toContain(REAL_OPENAI);
    expect(childEnv.ANTHROPIC_API_KEY?.startsWith(CREDENTIAL_RELAY_PLACEHOLDER_PREFIX)).toBe(true);
    expect(childEnv.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    // A proxy-honoring CLI must reach the loopback relay directly.
    expect(childEnv.NO_PROXY).toBe('corp.example,127.0.0.1,localhost,::1');
    expect(childEnv.no_proxy).toBe('127.0.0.1,localhost,::1');
    expect(childEnv.HTTPS_PROXY).toBe('http://proxy.corp.example:3128');

    const ok = await call(`${childEnv.ANTHROPIC_BASE_URL}/v1/messages`, {
      'x-api-key': childEnv.ANTHROPIC_API_KEY!,
    });
    expect(ok.status).toBe(200);
    expect(seen[0].headers['x-api-key']).toBe(REAL_ANTHROPIC);

    spawnEnv.dispose();
    await expect(
      call(`${childEnv.ANTHROPIC_BASE_URL}/v1/messages`, {
        'x-api-key': childEnv.ANTHROPIC_API_KEY!,
      })
    ).rejects.toThrow();
  });

  it('does not start for OAuth-login mode (no own API key) or unsupported providers', async () => {
    const env = baseEnv({ KYBERION_PROVIDER_CREDENTIAL_RELAY: '1' });
    expect(
      await prepareProviderCredentialRelay({
        provider: 'claude',
        credentialEnv: { PATH: '/bin' },
        baseEnv: env,
      })
    ).toBeNull();
    expect(
      await prepareProviderCredentialRelay({
        provider: 'grok',
        credentialEnv: { XAI_API_KEY: 'x'.repeat(20) },
        baseEnv: env,
      })
    ).toBeNull();
  });

  it('fails closed at a sync launch site: the key is dropped when no relay was started', () => {
    const spawnEnv = buildDelegationSpawnEnv({
      provider: 'codex',
      sessionId: 's',
      baseEnv: baseEnv({ KYBERION_PROVIDER_CREDENTIAL_RELAY: '1' }),
    });
    expect(spawnEnv.env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(spawnEnv.env)).not.toContain(REAL_OPENAI);
    spawnEnv.dispose();
  });

  it('withLoopbackNoProxy appends loopback once and keeps existing entries', () => {
    const env = withLoopbackNoProxy({ NO_PROXY: 'a.example, localhost', no_proxy: '' });
    expect(env.NO_PROXY).toBe('a.example,localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('127.0.0.1,localhost,::1');
    expect(withLoopbackNoProxy(env).NO_PROXY).toBe(env.NO_PROXY);
  });

  it('applyProviderCredentialRelay leaves the env untouched when the flag is off', () => {
    const env = { OPENAI_API_KEY: REAL_OPENAI };
    expect(applyProviderCredentialRelay({ provider: 'codex', env, baseEnv: {} })).toBe(env);
  });
});
