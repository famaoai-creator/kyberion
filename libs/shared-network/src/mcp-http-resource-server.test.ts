import { createServer, request, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpHttpResourceServer,
  MCP_REQUEST_TOOLS,
  type McpHttpResourceServerConfig,
} from './mcp-http-resource-server.js';
import {
  HUMAN_REQUEST_READ_SCOPE,
  HUMAN_REQUEST_RECEIVE_SCOPE,
} from '@agent/core/surface/verified-human-request-identity';

const registry = vi.hoisted(() => ({ members: [] as Array<Record<string, unknown>> }));
vi.mock('@agent/core/organization/member-registry', () => ({
  listMemberIdsStrict: () => registry.members.map((member) => member.member_id),
  readMemberProfile: (id: string) =>
    registry.members.find((member) => member.member_id === id) ?? null,
}));
const ISSUER = 'https://issuer.example';
const RESOURCE = 'https://requests.example/mcp';
const ID = '11111111-1111-4111-8111-111111111111';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'test-key',
  alg: 'RS256',
  use: 'sig',
};
const servers: Server[] = [];
function token(
  subject = 'alice-sub',
  scopes = `${HUMAN_REQUEST_READ_SCOPE} ${HUMAN_REQUEST_RECEIVE_SCOPE}`,
  claims = {}
) {
  const now = Math.floor(Date.now() / 1000);
  const input = [
    { alg: 'RS256', typ: 'at+jwt', kid: 'test-key' },
    {
      iss: ISSUER,
      aud: RESOURCE,
      sub: subject,
      client_id: 'synthetic-client',
      jti: 'test-jti',
      iat: now,
      exp: now + 300,
      scope: scopes,
      ...claims,
    },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${input}.${sign('sha256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
}
function config(): McpHttpResourceServerConfig {
  return {
    enabled: true,
    token: {
      issuer: ISSUER,
      resource: RESOURCE,
      algorithms: ['RS256'],
      jwks: { keys: [publicKey] },
    },
    policy: {
      authorityNamespace: 'test-deployment',
      tenantSlugs: ['alpha', 'beta'],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['public', 'confidential'],
    },
  };
}
const receive = vi.fn();
const read = vi.fn();
const audit = vi.fn();
interface HttpTestBody {
  error?: string;
  result?: {
    protocolVersion?: string;
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
}
async function start(options: McpHttpResourceServerConfig | undefined = config()) {
  const app = express();
  app.use(createMcpHttpResourceServer(options, { receive, read, audit }));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_listener_missing');
  return async (
    body?: unknown,
    options: {
      path?: string;
      method?: string;
      bearer?: string | null;
      headers?: Record<string, string>;
      rawBody?: string;
    } = {}
  ) => {
    const headers = {
      host: 'requests.example',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
      ...(options.bearer !== null ? { authorization: `Bearer ${options.bearer ?? token()}` } : {}),
      ...options.headers,
    };
    const raw = options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    return new Promise<{ status: number; headers: Record<string, unknown>; body: HttpTestBody }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            method: options.method ?? 'POST',
            path: options.path ?? '/mcp',
            headers,
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => {
              text += String(chunk);
            });
            res.on('end', () => {
              let result: HttpTestBody = { error: text };
              try {
                result = JSON.parse(text) as HttpTestBody;
              } catch {
                /* 404/empty SDK notifications */
              }
              resolve({ status: res.statusCode!, headers: res.headers, body: result });
            });
          }
        );
        req.on('error', reject);
        req.end(raw);
      }
    );
  };
}
function call(name = MCP_REQUEST_TOOLS.receive as string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: {
        requestId: ID,
        ...(name === MCP_REQUEST_TOOLS.receive
          ? { text: 'hello', requestCreatedAt: Date.now() }
          : {}),
        ...args,
      },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  registry.members = [
    {
      member_id: 'alice',
      status: 'active',
      memberships: [{ tenant_slug: 'alpha', role: 'operator' }],
      external_identities: [{ issuer: ISSUER, subject: 'alice-sub' }],
    },
    {
      member_id: 'bob',
      status: 'active',
      memberships: [{ tenant_slug: 'beta', role: 'operator' }],
      external_identities: [{ issuer: ISSUER, subject: 'bob-sub' }],
    },
  ];
  receive.mockResolvedValue({
    kind: 'replied',
    requestId: ID,
    payload: { reply: 'saved', mode: 'conversation', shape: 'reply' },
    historySaved: true,
  });
  read.mockReturnValue({
    requestId: ID,
    sessionId: 'scoped-session',
    replyStatus: 'answered',
    reply: 'saved',
    work: [],
  });
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('default-disabled MCP resource server', () => {
  it('supports only allowlisted browser preflights without granting cookie authority', async () => {
    const send = await start({ ...config(), allowedOrigins: ['https://client.example'] });
    const headers = {
      origin: 'https://client.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'Authorization, Content-Type, MCP-Protocol-Version',
    };
    const preflight = await send(undefined, { method: 'OPTIONS', bearer: null, headers });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://client.example');
    expect(preflight.headers).not.toHaveProperty('access-control-allow-credentials');
    expect(
      (
        await send(undefined, {
          method: 'OPTIONS',
          bearer: null,
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await send(undefined, {
          method: 'OPTIONS',
          bearer: null,
          headers: { ...headers, 'access-control-request-headers': 'cookie' },
        })
      ).status
    ).toBe(403);
    const denied = await send(call(), {
      bearer: null,
      headers: { origin: 'https://client.example' },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers['access-control-expose-headers']).toContain('WWW-Authenticate');
    expect(receive).not.toHaveBeenCalled();
  });
  it('sanitizes malformed and oversized JSON without executing or returning parser details', async () => {
    const send = await start();
    const malformed = await send(undefined, { rawBody: '{"private-marker":' });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'invalid_request_body' });
    const oversized = await send(undefined, {
      rawBody: JSON.stringify({ secret: 'a'.repeat(40_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ error: 'invalid_request_body' });
    expect(receive).not.toHaveBeenCalled();
  });
  it('accepts protocol metadata without trusting it as identity and refuses malformed request IDs', async () => {
    const send = await start();
    const message = call();
    const result = await send({
      ...message,
      params: { ...message.params, _meta: { progressToken: 42, memberId: 'bob' } },
    });
    expect(result.status).toBe(200);
    expect(receive.mock.calls[0][0].memberId).toBe('alice');
    expect(receive.mock.calls[0][1]).not.toHaveProperty('_meta');
    const { id: _id, ...notification } = message;
    expect((await send(notification)).status).toBe(400);
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it('creates no endpoints unless explicitly enabled', async () => {
    const send = await start({ ...config(), enabled: false });
    expect((await send(call())).status).toBe(404);
    expect(
      (await send(undefined, { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' }))
        .status
    ).toBe(404);
    expect(receive).not.toHaveBeenCalled();
  });
  it('publishes protected-resource metadata only, never AS endpoints', async () => {
    const send = await start();
    const result = await send(undefined, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      bearer: null,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: [HUMAN_REQUEST_READ_SCOPE],
    });
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/authorize',
      '/token',
      '/register',
      '/revoke',
    ])
      expect((await send(undefined, { method: 'GET', path })).status).toBe(404);
  });
  it('challenges missing, invalid, wrong-audience and wrong-issuer credentials before dispatch', async () => {
    const send = await start();
    for (const bearer of [
      null,
      'kys1.web-session',
      token('alice-sub', HUMAN_REQUEST_READ_SCOPE, { aud: 'https://other.example' }),
      token('alice-sub', HUMAN_REQUEST_READ_SCOPE, { iss: 'https://other.example' }),
    ]) {
      const result = await send(call(), { bearer });
      expect(result.status).toBe(401);
      expect(result.headers['www-authenticate']).toContain(
        'resource_metadata="https://requests.example/.well-known/oauth-protected-resource/mcp"'
      );
    }
    expect(receive).not.toHaveBeenCalled();
  });
  it('enforces operation scopes with HTTP 403 and required-scope challenge', async () => {
    const send = await start();
    const result = await send(call(), { bearer: token('alice-sub', HUMAN_REQUEST_READ_SCOPE) });
    expect(result.status).toBe(403);
    expect(result.headers['www-authenticate']).toContain(`scope="${HUMAN_REQUEST_RECEIVE_SCOPE}"`);
    expect(receive).not.toHaveBeenCalled();
    expect(
      (
        await send(call(MCP_REQUEST_TOOLS.result), {
          bearer: token('alice-sub', HUMAN_REQUEST_RECEIVE_SCOPE),
        })
      ).status
    ).toBe(403);
  });
  it('rejects cookies, query credentials, wrong Host and Origin, batches and unknown catalog tools', async () => {
    const send = await start();
    expect(
      (await send(call(), { bearer: null, headers: { cookie: `kyberion_session=${token()}` } }))
        .status
    ).toBe(401);
    expect((await send(call(), { path: `/mcp?access_token=${token()}` })).status).toBe(400);
    expect((await send(call(), { headers: { host: 'attacker.example' } })).status).toBe(403);
    expect((await send(call(), { headers: { origin: 'https://attacker.example' } })).status).toBe(
      403
    );
    expect((await send([call()])).status).toBe(400);
    expect((await send(call('kyberion.pipeline.run'))).status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });
  it('authenticates initialization and restricts catalog to three tools', async () => {
    const send = await start();
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    };
    expect((await send(init, { bearer: null })).status).toBe(401);
    const initialized = await send(init);
    expect(initialized.status).toBe(200);
    expect(initialized.body.result.protocolVersion).toBe('2025-11-25');
    const listed = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      Object.values(MCP_REQUEST_TOOLS).sort()
    );
  });
  it('isolates concurrent users with explicit per-request authority and separate audit provenance', async () => {
    const send = await start();
    const responses = await Promise.all([send(call()), send(call(), { bearer: token('bob-sub') })]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      receive.mock.calls.map(([viewer]) => [viewer.principalId, viewer.tenantSlugs]).sort()
    ).toEqual([
      ['user:alice', ['alpha']],
      ['user:bob', ['beta']],
    ]);
    for (const [viewer] of receive.mock.calls) expect(viewer.role).toBe('readonly');
    expect(audit.mock.calls.map(([event]) => event.subject).sort()).toEqual([
      'alice-sub',
      'bob-sub',
    ]);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(token());
  });
  it('rejects unmapped, ambiguous, suspended and tenant-downgraded identities', async () => {
    const send = await start();
    expect(
      (
        await send(call(), {
          bearer: token('unbound', HUMAN_REQUEST_RECEIVE_SCOPE, {
            member_id: 'alice',
            kyberion_role: 'localadmin',
          }),
        })
      ).status
    ).toBe(403);
    registry.members[0].status = 'suspended';
    expect((await send(call())).status).toBe(403);
    registry.members[0].status = 'active';
    registry.members.push({ ...registry.members[0], member_id: 'duplicate' });
    expect((await send(call())).status).toBe(403);
    registry.members.pop();
    registry.members[0].memberships = [{ tenant_slug: 'alpha', role: 'viewer' }];
    expect((await send(call())).status).toBe(403);
    expect((await send(call(MCP_REQUEST_TOOLS.result))).status).toBe(200);
    expect(receive).not.toHaveBeenCalled();
  });
  it('rejects identity injection and tenant widening before handler execution', async () => {
    const send = await start();
    expect((await send(call(MCP_REQUEST_TOOLS.receive, { memberId: 'bob' }))).status).toBe(400);
    expect((await send(call(MCP_REQUEST_TOOLS.receive, { tenant: 'beta' }))).status).toBe(403);
    expect(receive).not.toHaveBeenCalled();
  });
  it('reads status/result without replaying receive or returning a reply as task completion', async () => {
    const send = await start();
    const status = await send(call(MCP_REQUEST_TOOLS.status));
    const statusValue = JSON.parse(status.body.result.content[0].text);
    expect(statusValue).toMatchObject({ replyStatus: 'answered', work: [] });
    expect(statusValue).not.toHaveProperty('reply');
    const result = await send(call(MCP_REQUEST_TOOLS.result));
    expect(JSON.parse(result.body.result.content[0].text)).toMatchObject({
      reply: 'saved',
      replyStatus: 'answered',
    });
    expect(receive).not.toHaveBeenCalled();
  });
  it('does not dispatch when audit fails and never retries a failed application operation', async () => {
    const send = await start();
    audit.mockImplementationOnce(() => {
      throw new Error('audit unavailable');
    });
    expect((await send(call())).body.result.isError).toBe(true);
    expect(receive).not.toHaveBeenCalled();
    receive.mockRejectedValueOnce(new Error('unknown outcome'));
    expect((await send(call())).body.result.isError).toBe(true);
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it('authenticates but rejects unsupported GET/DELETE and checks every request again', async () => {
    const send = await start();
    expect((await send(undefined, { method: 'GET', bearer: null })).status).toBe(401);
    expect((await send(undefined, { method: 'GET' })).status).toBe(405);
    expect((await send(undefined, { method: 'DELETE' })).status).toBe(405);
    expect((await send(call())).status).toBe(200);
    registry.members[0].status = 'suspended';
    expect((await send(call())).status).toBe(403);
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
