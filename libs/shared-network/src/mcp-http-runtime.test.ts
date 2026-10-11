import { createServer, request, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HumanRequestRuntimeConfig } from '@agent/core/surface/human-request-runtime-config';
import { createMcpHttpRuntime } from './mcp-http-runtime.js';

vi.mock('@agent/core/organization/member-registry', () => ({
  listMemberIdsStrict: () => ['alice'],
  readMemberProfile: () => ({
    member_id: 'alice',
    status: 'active',
    memberships: [{ tenant_slug: 'beta', role: 'operator' }],
    external_identities: [{ issuer: 'https://issuer.example', subject: 'alice' }],
  }),
}));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'test',
  alg: 'RS256',
  use: 'sig',
};
function config(): HumanRequestRuntimeConfig {
  return {
    version: 1,
    policy: {
      authorityNamespace: 'runtime-test',
      tenantSlugs: ['alpha'],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['public'],
    },
    httpMcp: {
      enabled: true,
      token: {
        issuer: 'https://issuer.example',
        resource: 'https://requests.example/api/mcp',
        algorithms: ['RS256'],
        jwks: { keys: [publicKey] },
      },
    },
  };
}
const servers: Server[] = [];
async function serve(app?: ReturnType<typeof createMcpHttpRuntime>['app']) {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic listener missing');
  return { server, port: address.port };
}
function send(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, headers: { host: 'requests.example', ...headers } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += String(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('HTTP MCP runtime composition', () => {
  it('is default-off, does not trust proxies and cannot start without explicit enablement', async () => {
    const runtime = createMcpHttpRuntime();
    expect(runtime.enabled).toBe(false);
    expect(runtime.app.get('trust proxy')).toBe(false);
    await expect(runtime.start()).rejects.toThrow('requires enabled');
    const { port } = await serve(runtime.app);
    expect((await send(port, '/api/mcp')).status).toBe(404);
    expect((await send(port, '/.well-known/oauth-protected-resource/api/mcp')).status).toBe(404);
  });
  it('mounts the resource and RFC9728 metadata at root and ignores forged forwarded headers', async () => {
    const runtime = createMcpHttpRuntime(config());
    const { port } = await serve(runtime.app);
    const metadata = await send(port, '/.well-known/oauth-protected-resource/api/mcp');
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.body).resource).toBe('https://requests.example/api/mcp');
    expect((await send(port, '/api/mcp')).status).toBe(401);
    expect(
      (
        await send(port, '/api/mcp', {
          host: 'evil.example',
          'x-forwarded-host': 'requests.example',
          'x-forwarded-proto': 'https',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await send(port, '/api/mcp', {
          'x-forwarded-host': 'evil.example',
          forwarded: 'host=evil.example;proto=http',
        })
      ).status
    ).toBe(401);
  });
  it('does full local crypto validation and sanitizes its errors', () => {
    const input = config();
    input.httpMcp!.token!.jwks.keys[0] = {
      kty: 'RSA',
      kid: 'secret-test-value',
      alg: 'RS256',
      n: 'invalid',
      e: 'AQAB',
    };
    expect(() => createMcpHttpRuntime(input)).toThrow('Invalid HTTP MCP runtime configuration');
    expect(() =>
      createMcpHttpRuntime({ ...config(), extra: true } as HumanRequestRuntimeConfig)
    ).toThrow('Invalid HTTP MCP runtime configuration');
  });
  it.each(['0.0.0.0', 'localhost', '::', '127.0.0.2'])('rejects non-exact loopback %s', (host) => {
    const input = config();
    input.httpMcp!.deployment = {
      mode: 'loopback-reverse-proxy',
      host: host as '127.0.0.1',
      port: 4321,
    };
    expect(() => createMcpHttpRuntime(input)).toThrow('Invalid HTTP MCP');
  });
  it.each([0, -1, 65536, 1.5])('rejects invalid port %s during validation', (port) => {
    const input = config();
    input.httpMcp!.deployment = { mode: 'loopback-reverse-proxy', host: '127.0.0.1', port };
    expect(() => createMcpHttpRuntime(input)).toThrow('Invalid HTTP MCP');
  });
  it('prevents caller mutation from widening the final tenant policy', async () => {
    const input = config();
    const runtime = createMcpHttpRuntime(input);
    input.policy!.tenantSlugs = ['alpha', 'beta'];
    const { port } = await serve(runtime.app);
    const now = Math.floor(Date.now() / 1000);
    const raw = [
      { alg: 'RS256', typ: 'at+jwt', kid: 'test' },
      {
        iss: 'https://issuer.example',
        aud: 'https://requests.example/api/mcp',
        sub: 'alice',
        client_id: 'test',
        jti: 'test',
        iat: now,
        exp: now + 60,
        scope: 'kyberion:requests:read',
      },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
      .join('.');
    const token =
      raw + '.' + sign('sha256', Buffer.from(raw), keys.privateKey).toString('base64url');
    expect((await send(port, '/api/mcp', { authorization: 'Bearer ' + token })).status).toBe(403);
  });
  it('requires deployment at start and sanitizes occupied-port failures', async () => {
    await expect(createMcpHttpRuntime(config()).start()).rejects.toThrow('requires enabled');
    const { port } = await serve();
    const input = config();
    input.httpMcp!.deployment = { mode: 'loopback-reverse-proxy', host: '127.0.0.1', port };
    await expect(createMcpHttpRuntime(input).start()).rejects.toThrow('HTTP MCP listener failed');
  });
  it('starts only an explicit disposable loopback listener and supports idempotent shutdown', async () => {
    const reservation = await serve();
    await new Promise<void>((resolve) => reservation.server.close(() => resolve()));
    const input = config();
    input.httpMcp!.deployment = {
      mode: 'loopback-reverse-proxy',
      host: '127.0.0.1',
      port: reservation.port,
    };
    const runtime = createMcpHttpRuntime(input);
    input.httpMcp!.deployment!.port = 0;
    const handle = await runtime.start();
    try {
      expect((await send(reservation.port, '/api/mcp')).status).toBe(401);
      await expect(runtime.start()).rejects.toThrow('requires enabled');
    } finally {
      await handle.close();
    }
    await handle.close();
    expect(await handle.closed).toBe('closed');
  });
});
