/** Signed browser-session + OAuth HTTP integration; only external effects are synthetic. */
import { createServer, request, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberProfile } from '@agent/core/organization/member-registry';

const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  members: [] as MemberProfile[],
  unavailable: false,
  writes: 0,
  locks: 0,
  run: vi.fn(),
  audit: vi.fn(),
}));
import { secretGuard } from '@agent/core/secret/secret-guard';
vi.mock('@agent/core/organization/member-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/organization/member-registry')>()),
  findMemberByExternalIdentity: (issuer: string, subject: string) =>
    state.members.find(
      (member) =>
        member.status === 'active' &&
        member.external_identities?.some(
          (binding) => binding.issuer === issuer && binding.subject === subject
        )
    ) ?? null,
  externalIdentityBindingDenied: (issuer: string, subject: string) =>
    state.members.some(
      (member) =>
        member.status !== 'active' &&
        member.external_identities?.some(
          (binding) => binding.issuer === issuer && binding.subject === subject
        )
    ),
  listMemberIdsStrict: () => {
    if (state.unavailable) throw new Error('private-registry-marker');
    return state.members.map((member) => member.member_id);
  },
  readMemberProfile: (id: string) =>
    structuredClone(state.members.find((member) => member.member_id === id) ?? null),
}));
vi.mock('@agent/core/lock-utils', () => ({
  withLockSync: (_key: string, fn: () => unknown) => {
    state.locks++;
    return fn();
  },
}));
vi.mock('@agent/core/workforce/artifact-store', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(state.files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) => {
    state.writes++;
    state.files.set(path, structuredClone(value));
  },
}));
vi.mock('@agent/core/surface/channel-surface', () => ({
  runSurfaceMessageConversation: state.run,
}));
vi.mock('@agent/core/surface/front-desk-execution-contract', async (original) => ({
  ...(await original<typeof import('@agent/core/surface/front-desk-execution-contract')>()),
  loadFrontDeskExecutionPolicy: () => ({ version: 1, mappings: [] }),
}));

import {
  mintBrowserSessionToken,
  verifiedBrowserSessionIdentity,
} from '@agent/core/authn-providers';
import { resolveAuthnSurfaceViewerScope } from '@agent/core/surface/surface-authn';
import {
  resolveBrowserHumanRequestIdentity,
  authorizeBrowserHumanRequest,
} from '@agent/core/surface/browser-human-request';
import { runFrontDeskRequest } from '@agent/core/surface/front-desk-request-service';
import { readFrontDeskRequest } from '@agent/core/surface/front-desk-request-result';
import { conversationRef } from '@agent/core/surface/front-desk-conversation-store';
import {
  HUMAN_REQUEST_READ_SCOPE,
  HUMAN_REQUEST_RECEIVE_SCOPE,
} from '@agent/core/surface/verified-human-request-identity';
import type { HumanRequestRuntimeConfig } from '@agent/core/surface/human-request-runtime-config';
import { SurfaceViewerScopeError } from '@agent/core/surface/surface-viewer-scope-contract';
import { createMcpHttpRuntime } from './mcp-http-runtime.js';
import { MCP_REQUEST_TOOLS } from './mcp-http-resource-server.js';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';
const ISSUER = 'https://synthetic-oauth.example';
const BROWSER_ISSUER = 'https://synthetic-browser.example';
const RESOURCE = 'https://synthetic-requests.example/mcp';
const ENV = { KYBERION_SESSION_SECRET: 'synthetic-browser-session-key-for-testing-only' };
const scopes = [HUMAN_REQUEST_READ_SCOPE, HUMAN_REQUEST_RECEIVE_SCOPE];
const narrowing = {
  tenant: 'alpha',
  organizationId: 'org-a',
  projectId: 'project-a',
  tier: 'public' as const,
};
const input = () => ({ text: 'Synthetic request', requestId: ID, requestCreatedAt: NOW });
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config: HumanRequestRuntimeConfig = {
  version: 1,
  policy: {
    authorityNamespace: 'synthetic-cross-entry:v1',
    tenantSlugs: ['alpha'],
    organizationIds: ['org-a'],
    projectIds: ['project-a'],
    tierAccess: ['public', 'confidential'],
  },
  browser: { enabled: true, operationScopes: scopes },
  httpMcp: {
    enabled: true,
    token: {
      issuer: ISSUER,
      resource: RESOURCE,
      algorithms: ['RS256'],
      jwks: {
        keys: [
          {
            ...keys.publicKey.export({ format: 'jwk' }),
            kid: 'synthetic-key',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      },
    },
  },
};
function member(id: string): MemberProfile {
  return {
    member_id: id,
    display_name: 'Synthetic ' + id,
    status: 'active',
    memberships: [{ tenant_slug: 'alpha', role: 'operator' }],
    external_identities: [
      { issuer: ISSUER, subject: id + '-oauth' },
      { issuer: BROWSER_ISSUER, subject: id + '-browser' },
    ],
    access_registrations: [],
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };
}
function browser(id = 'alice') {
  const token = mintBrowserSessionToken(
    { idpIssuer: BROWSER_ISSUER, subject: id + '-browser', ttlSeconds: 300 },
    { env: ENV, now: NOW }
  ).token;
  const { scope, principal } = resolveAuthnSurfaceViewerScope({
    token,
    local: false,
    providerIds: ['browser-session'],
    allowPersonalTier: false,
    deps: { env: ENV, now: NOW },
  });
  expect(verifiedBrowserSessionIdentity(principal)).toMatchObject({
    issuer: BROWSER_ISSUER,
    subject: id + '-browser',
  });
  return { ...scope, principal };
}
type BrowserViewer = ReturnType<typeof browser>;
function browserIdentity(viewer: BrowserViewer) {
  const identity = resolveBrowserHumanRequestIdentity(viewer, config, narrowing, { now: NOW });
  if (!identity) throw new Error('synthetic_browser_identity_missing');
  return identity;
}
async function browserReceive(viewer: BrowserViewer) {
  const identity = browserIdentity(viewer);
  authorizeBrowserHumanRequest(identity, 'receive', ID, state.audit);
  return runFrontDeskRequest(identity.viewer, input());
}
function browserRead(viewer: BrowserViewer) {
  const identity = browserIdentity(viewer);
  authorizeBrowserHumanRequest(identity, 'result', ID, state.audit);
  return readFrontDeskRequest(identity.viewer, ID);
}
function bearer(id = 'alice') {
  const signed = [
    { alg: 'RS256', typ: 'at+jwt', kid: 'synthetic-key' },
    {
      iss: ISSUER,
      aud: RESOURCE,
      sub: id + '-oauth',
      client_id: 'synthetic-client',
      jti: 'synthetic-jti',
      iat: NOW / 1000,
      exp: NOW / 1000 + 300,
      scope: scopes.join(' '),
    },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return signed + '.' + sign('sha256', Buffer.from(signed), keys.privateKey).toString('base64url');
}
interface RpcBody {
  error?: unknown;
  result?: { isError?: boolean; content?: Array<{ text: string }> };
}
const servers: Server[] = [];
async function start() {
  // Actual runtime composition mounts the actual resource server, authentication, and default services.
  // Only this fixture binds an ephemeral localhost socket; no deployment configuration is used.
  const runtime = createMcpHttpRuntime(config, { audit: state.audit });
  const server = createServer(runtime.app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('synthetic_listener_missing');
  return async (operation: 'receive' | 'result' | 'status', id = 'alice') => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: MCP_REQUEST_TOOLS[operation],
        arguments: { ...narrowing, requestId: ID, ...(operation === 'receive' ? input() : {}) },
      },
    };
    return new Promise<{ status: number; body: RpcBody }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          method: 'POST',
          path: '/mcp',
          headers: {
            host: 'synthetic-requests.example',
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            authorization: 'Bearer ' + bearer(id),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += String(chunk);
          });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(text) as RpcBody });
            } catch {
              reject(new Error('synthetic_response_not_json'));
            }
          });
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  };
}
type Send = Awaited<ReturnType<typeof start>>;
async function mcp(send: Send, operation: 'receive' | 'result' | 'status', id = 'alice') {
  const response = await send(operation, id);
  expect(response.status).toBe(200);
  expect(response.body.result?.isError).not.toBe(true);
  const text = response.body.result?.content?.[0]?.text;
  expect(text).toBeTypeOf('string');
  return JSON.parse(text!) as Record<string, unknown>;
}
function effects() {
  return {
    writes: state.writes,
    locks: state.locks,
    runs: state.run.mock.calls.length,
    files: state.files.size,
  };
}
beforeEach(() => {
  vi.spyOn(secretGuard, 'loadConnectionDocument').mockReturnValue({});
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.files.clear();
  state.members = [member('alice'), member('bob')];
  state.unavailable = false;
  state.writes = 0;
  state.locks = 0;
  state.run.mockReset().mockResolvedValue({ text: 'Synthetic stored answer.' });
  state.audit.mockReset();
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        })
    )
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('authenticated browser and HTTP MCP share the actual request lifecycle', () => {
  it.each(['browser', 'mcp'] as const)(
    'reserves through %s once, shares pending state, and replays the same stored result in both entries',
    async (first) => {
      const viewer = browser();
      const send = await start();
      let entered!: () => void;
      let release!: (value: { text: string }) => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const answer = new Promise<{ text: string }>((resolve) => {
        release = resolve;
      });
      state.run.mockImplementationOnce(() => {
        entered();
        return answer;
      });
      const running = first === 'browser' ? browserReceive(viewer) : mcp(send, 'receive');
      await started;
      try {
        const beforeRead = effects();
        expect(browserRead(viewer)).toMatchObject({ requestId: ID, replyStatus: 'pending' });
        expect(await mcp(send, 'result')).toMatchObject({ requestId: ID, replyStatus: 'pending' });
        expect(effects()).toEqual(beforeRead);
        expect(await (first === 'browser' ? mcp(send, 'receive') : browserReceive(viewer))).toEqual(
          { kind: 'pending', requestId: ID }
        );
        expect(state.writes).toBe(beforeRead.writes);
        expect(state.run).toHaveBeenCalledTimes(1);
      } finally {
        release({ text: 'Synthetic stored answer.' });
      }
      expect(await running).toMatchObject({ kind: 'replied', requestId: ID, historySaved: true });
      const beforeRead = effects();
      const stored = browserRead(viewer);
      expect(await mcp(send, 'result')).toEqual(stored);
      expect(stored).toMatchObject({
        requestId: ID,
        replyStatus: 'answered',
        reply: 'Synthetic stored answer.',
      });
      expect(effects()).toEqual(beforeRead);
      expect(await browserReceive(viewer)).toEqual({
        kind: 'replayed',
        requestId: ID,
        reply: 'Synthetic stored answer.',
      });
      expect(await mcp(send, 'receive')).toEqual({
        kind: 'replayed',
        requestId: ID,
        reply: 'Synthetic stored answer.',
      });
      expect(state.run).toHaveBeenCalledTimes(1);
      expect(state.files.size).toBe(1);
      expect(state.writes).toBe(beforeRead.writes);
      expect(state.run).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user:alice',
          messageId: ID,
          conversationKey: conversationRef(browserIdentity(viewer).viewer).key,
        })
      );
      expect(state.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          memberId: 'alice',
          issuer: BROWSER_ISSUER,
          transport: 'browser-session',
        })
      );
      expect(state.audit).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: 'alice', issuer: ISSUER, transport: 'mcp-oauth' })
      );
    }
  );
  it.each(['browser', 'mcp'] as const)(
    'never reexecutes an uncertain request first received through %s',
    async (first) => {
      const viewer = browser();
      const send = await start();
      state.run.mockRejectedValueOnce(new Error('private-execution-marker'));
      expect(await (first === 'browser' ? browserReceive(viewer) : mcp(send, 'receive'))).toEqual({
        kind: 'uncertain',
        requestId: ID,
        existing: false,
      });
      const before = effects();
      expect(browserRead(viewer)).toMatchObject({ replyStatus: 'uncertain' });
      expect(await mcp(send, 'result')).toEqual(browserRead(viewer));
      expect(await browserReceive(viewer)).toEqual({
        kind: 'uncertain',
        requestId: ID,
        existing: true,
      });
      expect(await mcp(send, 'receive')).toEqual({
        kind: 'uncertain',
        requestId: ID,
        existing: true,
      });
      expect(state.run).toHaveBeenCalledTimes(1);
      expect(state.writes).toBe(before.writes);
      expect(JSON.stringify(await mcp(send, 'result'))).not.toContain('private-execution-marker');
    }
  );
  it('isolates distinct authenticated members even with an identical UUID and tenant', async () => {
    const alice = browser();
    const bob = browser('bob');
    const send = await start();
    state.run
      .mockResolvedValueOnce({ text: 'Alice answer.' })
      .mockResolvedValueOnce({ text: 'Bob answer.' });
    await browserReceive(alice);
    expect(await mcp(send, 'result', 'bob')).toEqual({ kind: 'not_found', requestId: ID });
    expect(browserRead(bob)).toBeUndefined();
    await mcp(send, 'receive', 'bob');
    expect(await mcp(send, 'result')).toEqual(browserRead(alice));
    expect(await mcp(send, 'result', 'bob')).toEqual(browserRead(bob));
    expect(browserRead(alice)?.reply).toBe('Alice answer.');
    expect(browserRead(bob)?.reply).toBe('Bob answer.');
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(state.files.size).toBe(2);
  });
  it.each(['suspended', 'aliases_removed', 'registry_unavailable'] as const)(
    'fails closed on %s after authentication and a completed request, without replay or writes',
    async (mode) => {
      const viewer = browser();
      const send = await start();
      await browserReceive(viewer);
      expect(await mcp(send, 'result')).toEqual(browserRead(viewer));
      if (mode === 'suspended') state.members[0].status = 'suspended';
      if (mode === 'aliases_removed') state.members[0].external_identities = [];
      if (mode === 'registry_unavailable') state.unavailable = true;
      const before = effects();
      const audits = state.audit.mock.calls.length;
      expect(() => browserRead(viewer)).toThrow(SurfaceViewerScopeError);
      await expect(browserReceive(viewer)).rejects.toThrow('Verified human identity denied.');
      for (const operation of ['receive', 'result'] as const) {
        const response = await send(operation);
        expect(response.status).toBe(403);
        expect(JSON.stringify(response.body)).not.toMatch(
          /private-registry-marker|Alice|Synthetic stored answer/
        );
      }
      expect(effects()).toEqual(before);
      expect(state.audit).toHaveBeenCalledTimes(audits);
    }
  );
  it('denies both entries before any execution or reservation when operation audit fails', async () => {
    const viewer = browser();
    const send = await start();
    state.audit.mockImplementation(() => {
      throw new Error('private-audit-marker');
    });
    const before = effects();
    await expect(browserReceive(viewer)).rejects.toThrow('private-audit-marker');
    const response = await send('receive');
    expect(response.status).toBe(200);
    expect(response.body.result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'request_operation_failed' }],
    });
    expect(effects()).toEqual(before);
  });
});
