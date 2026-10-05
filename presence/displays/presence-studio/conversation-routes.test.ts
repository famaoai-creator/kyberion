import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type express from 'express';
const fixtures = vi.hoisted(() => ({ files: new Map<string, unknown>(), run: vi.fn() }));
vi.mock('@agent/core/surface/channel-surface', () => ({
  runSurfaceMessageConversation: fixtures.run,
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/lock-utils', () => ({
  withLockSync: (_key: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/workforce/artifact-store', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(fixtures.files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) =>
    fixtures.files.set(path, structuredClone(value)),
}));
vi.mock('@agent/core/surface/surface-url', () => ({
  resolveSurfaceBrowserUrl: () => 'https://desk.example.test',
}));
vi.mock('@agent/core/surface/surface-ux-contract', () => ({
  checkAndRepairSurfaceUxContract: (text: string) => ({ text }),
}));
vi.mock('@agent/core/intent/intent-resolution', () => ({ loadStandardIntentCatalog: () => [] }));
import {
  SurfaceConversationAdmissionError,
  SurfaceConversationCapabilityError,
} from '@agent/core/surface/surface-conversation-runtime-context';
import { registerConversationRoutes } from './conversation-routes.js';
const handlers = new Map<string, express.RequestHandler>();
registerConversationRoutes({
  get: (path: string, fn: express.RequestHandler) => handlers.set('GET ' + path, fn),
  post: (path: string, fn: express.RequestHandler) => handlers.set('POST ' + path, fn),
} as unknown as express.Express);
async function request(method = 'GET', body: unknown = {}, tenant?: string, remote = '127.0.0.1') {
  const req = {
    body,
    query: tenant ? { tenant } : {},
    headers: { host: '127.0.0.1:3031' },
    socket: { remoteAddress: remote },
    path: '/api/conversation',
    originalUrl: '/api/conversation',
    url: '/api/conversation',
    method,
  } as unknown as express.Request;
  const response = {
    statusCode: 200,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value as Record<string, unknown>;
      return this;
    },
  };
  await handlers.get(method + ' /api/conversation')!(
    req,
    response as unknown as express.Response,
    vi.fn()
  );
  return response;
}
beforeEach(() => {
  fixtures.files.clear();
  fixtures.run.mockReset();
  vi.stubEnv('KYBERION_TENANT', 'alpha-team');
  fixtures.run.mockResolvedValue({
    text: 'A real reply',
    delegationResults: [],
    approvalRequests: [],
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('durable Ask HTTP handlers', () => {
  it('restores server-owned history and executes one scoped request once', async () => {
    const history = await request();
    expect(history.statusCode).toBe(200);
    expect(history.body.sessionId).toMatch(/^concierge-/);
    const input = {
      text: 'Do this',
      conversation_id: history.body.sessionId,
      request_id: '12345678-1234-4234-8234-123456789abc',
      tenant: 'alpha-team',
    };
    const reply = await request('POST', input);
    expect(reply.body).toMatchObject({
      ok: true,
      reply: 'A real reply',
      request_id: input.request_id,
    });
    expect(fixtures.run).toHaveBeenCalledWith(
      expect.objectContaining({
        threadTs: history.body.sessionId,
        correlationId: input.request_id,
        scope: expect.objectContaining({
          scope_kind: 'tenant',
          tier: 'confidential',
          tenant_slug: 'alpha-team',
          viewer_principal: 'human:concierge-localadmin',
        }),
        conversationKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        conversationHistory: [],
      })
    );
    const replay = await request('POST', input);
    expect(replay.body).toMatchObject({ ok: true, replayed: true, shape: 'reply' });
    expect(fixtures.run).toHaveBeenCalledTimes(1);
    expect((await request()).body.messages).toHaveLength(2);
  });
  it('returns actionable 503 and preserves uncertain request without success reply or second execution', async () => {
    fixtures.run.mockRejectedValue(new Error('provider unavailable'));
    const input = { text: 'Do this', request_id: '12345678-1234-4234-8234-123456789abc' };
    const result = await request('POST', input);
    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({
      ok: false,
      retry_safe: false,
      mode: 'unavailable',
      next_action: { href: 'https://desk.example.test/settings' },
    });
    expect(result.body.reply).toBeUndefined();
    const replay = await request('POST', input);
    expect(replay.statusCode).toBe(202);
    expect(replay.body.pending).toBe(true);
    expect(fixtures.run).toHaveBeenCalledTimes(1);
    expect((await request()).body).toMatchObject({
      pending: 1,
      messages: [{ role: 'user', text: 'Do this' }],
    });
  });
  it('rejects tenant widening, foreign sessions and changed idempotency payloads before execution', async () => {
    expect((await request('POST', { text: 'secret', tenant: 'beta-team' })).statusCode).toBe(403);
    expect(
      (await request('POST', { text: 'secret', conversation_id: 'concierge-' + 'a'.repeat(64) }))
        .statusCode
    ).toBe(409);
    expect(fixtures.run).not.toHaveBeenCalled();
    const request_id = '12345678-1234-4234-8234-123456789abc';
    await request('POST', { text: 'hello there', request_id });
    expect((await request('POST', { text: 'other', request_id })).statusCode).toBe(409);
    expect(fixtures.run).toHaveBeenCalledTimes(1);
  });
  it('keeps remote mutations forbidden and never trusts speaker or unknown fields', async () => {
    expect(
      (await request('POST', { text: 'work' }, undefined, '192.0.2.5')).statusCode
    ).toBeGreaterThanOrEqual(401);
    expect((await request('POST', { text: 'work', speaker: 'human:owner' })).statusCode).toBe(400);
    expect(fixtures.run).not.toHaveBeenCalled();
  });
});

it('does not start a second execution for an overlapping pending POST', async () => {
  let finish!: (value: { text: string }) => void;
  fixtures.run.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const input = { text: 'Long request', request_id: '12345678-1234-4234-8234-123456789abc' };
  const first = request('POST', input);
  await Promise.resolve();
  const second = await request('POST', input);
  expect(second.statusCode).toBe(202);
  expect(second.body.pending).toBe(true);
  expect(fixtures.run).toHaveBeenCalledTimes(1);
  finish({ text: 'Finished once' });
  expect((await first).body.reply).toBe('Finished once');
});

it('restores bounded completed context on later requests, excluding current input', async () => {
  await request('POST', {
    text: 'First topic',
    request_id: '12345678-1234-4234-8234-123456789abc',
  });
  await request('POST', { text: 'Follow up', request_id: '12345678-1234-4234-8234-123456789abd' });
  expect(fixtures.run.mock.calls[1][0].conversationHistory).toEqual([
    { role: 'user', text: 'First topic' },
    { role: 'assistant', text: 'A real reply' },
  ]);
  expect(fixtures.run.mock.calls[1][0].conversationKey).toBe(
    fixtures.run.mock.calls[0][0].conversationKey
  );
});
it('permits same-ID retry only for typed admission rejected before execution', async () => {
  fixtures.run.mockRejectedValueOnce(
    new SurfaceConversationAdmissionError('SURFACE_CONVERSATION_BUSY')
  );
  const input = { text: 'Separate request', request_id: '12345678-1234-4234-8234-123456789abc' };
  const busy = await request('POST', input);
  expect(busy.statusCode).toBe(409);
  expect(busy.body).toMatchObject({ error: 'conversation_not_started', retry_safe: true });
  expect((await request()).body.pending).toBe(0);
  expect((await request('POST', input)).body.reply).toBe('A real reply');
  expect(fixtures.run).toHaveBeenCalledTimes(2);
});
it('returns explicit unsupported capability without blind replay or success', async () => {
  fixtures.run.mockRejectedValueOnce(new SurfaceConversationCapabilityError('a2a_delegation'));
  const input = { text: 'Delegate this', request_id: '12345678-1234-4234-8234-123456789abc' };
  const result = await request('POST', input);
  expect(result.statusCode).toBe(422);
  expect(result.body).toMatchObject({
    ok: false,
    error: 'conversation_capability_unsupported',
    capability: 'a2a_delegation',
    retry_safe: false,
  });
  expect((await request('POST', input)).statusCode).toBe(202);
  expect(fixtures.run).toHaveBeenCalledTimes(1);
});

it('carries selected organization/project as the exact server-validated runtime lineage', async () => {
  const result = await request('POST', {
    text: 'Project discussion',
    organizationId: 'org-a',
    projectId: 'project-a',
  });
  expect(result.statusCode).toBe(200);
  expect(fixtures.run).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: expect.objectContaining({
        scope_kind: 'project',
        tenant_slug: 'alpha-team',
        organization_id: 'org-a',
        project_id: 'project-a',
        viewer_principal: 'human:concierge-localadmin',
      }),
    })
  );
});
it('refuses incomplete project lineage before reserving or executing', async () => {
  const result = await request('POST', { text: 'Project discussion', projectId: 'project-a' });
  expect(result.statusCode).toBe(409);
  expect(result.body).toMatchObject({
    error: 'conversation_scope_selection_required',
    retry_safe: true,
  });
  expect(fixtures.run).not.toHaveBeenCalled();
  expect(fixtures.files.size).toBe(0);
});

describe('request continuity at the actual front-desk ingress', () => {
  async function say(text: string, request_id?: string) {
    return request('POST', {
      text,
      locale: 'ja',
      tenant: 'alpha-team',
      ...(request_id ? { request_id } : {}),
    });
  }
  it('records A and B, answers named A, clarifies an ambiguous reference, and recovers the selection', async () => {
    const a = await say('Aの報告書を作って', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const b = await say('Bの旅行計画を作って', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(a.body).toMatchObject({ ok: true, mode: 'orchestrator', reply: 'A real reply' });
    expect(b.body).toMatchObject({ ok: true, mode: 'orchestrator', reply: 'A real reply' });
    expect(fixtures.run).toHaveBeenCalledTimes(2);
    fixtures.run.mockClear();
    const status = await say('Aの件どう？');
    expect(status.body).toMatchObject({ mode: 'intake', shape: 'status_summary' });
    expect(status.body.reply).toContain('A');
    const vague = await say('さっきの件どう？');
    expect(vague.body).toMatchObject({ mode: 'intake', shape: 'clarification' });
    expect(vague.body.reply).toContain('A');
    expect(vague.body.reply).toContain('B');
    const selected = await say('1つ目');
    expect(selected.body).toMatchObject({ mode: 'intake', shape: 'status_summary' });
    expect(selected.body.reply).toContain('A');
    expect(fixtures.run).not.toHaveBeenCalled();
    const replay = await say('Aの報告書を作って', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(replay.body).toMatchObject({ mode: 'history', replayed: true, reply: a.body.reply });
    expect(fixtures.run).not.toHaveBeenCalled();
  });
  it('leaves combined requests and bare confirmations to the runtime', async () => {
    await say('Aの報告書を作って');
    fixtures.run.mockClear();
    const mixed = await say('Aの件どう？ それとBの旅行計画を作って');
    expect(mixed.body).toMatchObject({ mode: 'orchestrator', reply: 'A real reply' });
    expect((await say('はい')).body.mode).toBe('orchestrator');
    expect((await say('進めて')).body.mode).toBe('orchestrator');
    expect(fixtures.run).toHaveBeenCalledTimes(3);
  });
  it('answers named approval/cancel locally as non-executing intake', async () => {
    await say('Aの報告書を作って');
    fixtures.run.mockClear();
    expect((await say('Aの報告書を承認')).body).toMatchObject({ mode: 'intake' });
    expect((await say('Aの報告書をキャンセル')).body).toMatchObject({ mode: 'intake' });
    expect(fixtures.run).not.toHaveBeenCalled();
  });
});
