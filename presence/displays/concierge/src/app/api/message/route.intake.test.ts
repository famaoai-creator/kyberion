import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const fixtures = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  run: vi.fn(),
  viewer: {
    principalId: 'human:alice',
    role: 'localadmin' as const,
    source: 'token' as const,
    tenantSlugs: ['acme'],
    organizationIds: ['org-a'],
    projectIds: ['project-a'],
    tierAccess: ['public', 'confidential'] as Array<'public' | 'confidential'>,
  },
}));
vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../../../lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({ context: fixtures.viewer }),
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
vi.mock('@agent/core/surface/channel-surface', () => ({
  runSurfaceMessageConversation: fixtures.run,
}));
vi.mock('../../../lib/i18n', () => ({
  conciergeText: (key: string) => key,
  resolveConciergeLocale: () => 'ja',
}));
import { POST } from './route';
import { runFrontDeskRequest } from '@agent/core/surface/front-desk-request-service';
import { readFrontDeskRequest } from '@agent/core/surface/front-desk-request-result';
import { conversationRef } from '@agent/core/surface/front-desk-conversation-store';
async function say(text: string, requestId?: string) {
  const response = await POST(
    new NextRequest('http://localhost/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, locale: 'ja', ...(requestId ? { requestId } : {}) }),
    })
  );
  return { status: response.status, body: await response.json() };
}
beforeEach(() => {
  fixtures.files.clear();
  fixtures.run.mockReset();
  fixtures.run.mockResolvedValue({ text: 'Chat reply' });
  fixtures.viewer.principalId = 'human:alice';
});
describe('Concierge intake through the real shared store', () => {
  it('shares one durable request across core and Web while the first runtime is still pending', async () => {
    const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let runtimeStarted!: () => void;
    let releaseRuntime!: (result: { text: string }) => void;
    const started = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });
    const held = new Promise<{ text: string }>((resolve) => {
      releaseRuntime = resolve;
    });
    fixtures.run.mockImplementationOnce(() => {
      runtimeStarted();
      return held;
    });
    const first = runFrontDeskRequest(fixtures.viewer, { text: 'Hello', requestId, locale: 'ja' });
    await started;
    try {
      const duplicate = await say('Hello', requestId);
      expect(duplicate).toEqual({
        status: 202,
        body: {
          ok: false,
          error: 'conversation_pending',
          requestId,
          pending: true,
          retry_safe: false,
        },
      });
      expect(fixtures.run).toHaveBeenCalledOnce();
      expect(readFrontDeskRequest(fixtures.viewer, requestId)).toMatchObject({
        replyStatus: 'pending',
      });
    } finally {
      releaseRuntime({ text: 'One answer' });
    }
    expect(await first).toMatchObject({ kind: 'replied', historySaved: true });
    expect((await say('Hello', requestId)).body).toEqual({
      reply: 'One answer',
      mode: 'history',
      shape: 'reply',
      requestId,
      replayed: true,
    });
    expect(readFrontDeskRequest(fixtures.viewer, requestId)).toMatchObject({
      replyStatus: 'answered',
      reply: 'One answer',
    });
    expect(fixtures.run).toHaveBeenCalledOnce();
  });

  it('keeps interleaved trusted viewers in separate actor, scope, key and history partitions', async () => {
    const alice = { ...fixtures.viewer };
    const bob = {
      ...fixtures.viewer,
      principalId: 'human:bob',
      tenantSlugs: ['globex'],
      organizationIds: ['org-b'],
      projectIds: ['project-b'],
    };
    fixtures.run.mockResolvedValueOnce({ text: 'Alice private answer' });
    expect(await runFrontDeskRequest(alice, { text: 'Alice private context' })).toMatchObject({
      kind: 'replied',
      payload: { mode: 'orchestrator' },
    });
    fixtures.run.mockResolvedValueOnce({ text: 'Bob private answer' });
    expect(await runFrontDeskRequest(bob, { text: 'Bob private context' })).toMatchObject({
      kind: 'replied',
      payload: { mode: 'orchestrator' },
    });
    fixtures.run.mockClear();
    let runtimeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });
    let releaseRuntime!: (result: { text: string }) => void;
    const held = new Promise<{ text: string }>((resolve) => {
      releaseRuntime = resolve;
    });
    fixtures.run.mockImplementation(() => {
      runtimeStarted();
      return held;
    });
    const aliceTurn = runFrontDeskRequest(alice, { text: 'Tell me more' });
    await started;
    const bobTurn = runFrontDeskRequest(bob, { text: 'Tell me more' });
    const results = Promise.all([aliceTurn, bobTurn]);
    try {
      await vi.waitFor(() => expect(fixtures.run).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      for (const [input] of fixtures.run.mock.calls) {
        const isAlice = input.actorId === alice.principalId;
        const expected = isAlice ? alice : bob;
        expect(input.threadTs).toBe(conversationRef(expected).sessionId);
        expect(input.conversationKey).toBe(conversationRef(expected).key);
        expect(input.scope).toMatchObject({
          tenant_slug: expected.tenantSlugs[0],
          organization_id: expected.organizationIds[0],
          project_id: expected.projectIds[0],
          viewer_principal: expected.principalId,
        });
        expect(input.conversationHistory).toEqual([
          { role: 'user', text: isAlice ? 'Alice private context' : 'Bob private context' },
          { role: 'assistant', text: isAlice ? 'Alice private answer' : 'Bob private answer' },
        ]);
      }
    } finally {
      releaseRuntime({ text: 'Independent answer' });
    }
    expect((await results).map((result) => result.kind)).toEqual(['replied', 'replied']);
  });

  it('records A and B through the runtime and answers status from the persisted index', async () => {
    const first = await say('Aの報告書を作って', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(first.body).toMatchObject({ mode: 'orchestrator', reply: 'Chat reply' });
    expect((await say('Bの旅行計画を作って')).body.mode).toBe('orchestrator');
    expect(fixtures.run).toHaveBeenCalledTimes(2);
    fixtures.run.mockClear();
    const named = await say('Aの件どう？');
    expect(named.body).toMatchObject({ mode: 'intake', shape: 'status_summary' });
    expect(named.body.reply).toContain('Aの報告書');
    expect(named.body.reply).toContain('回答済み');
    expect(named.body.reply).toContain('Chat reply');
    const vague = await say('さっきの件どう？');
    expect(vague.body.shape).toBe('clarification');
    expect(vague.body.reply).toContain('A');
    expect(vague.body.reply).toContain('B');
    const selected = await say('1つ目');
    expect(selected.body.shape).toBe('status_summary');
    expect(selected.body.reply).toContain('A');
    const replay = await say('Aの報告書を作って', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(replay.body).toMatchObject({ mode: 'history', replayed: true, reply: first.body.reply });
    expect(fixtures.run).not.toHaveBeenCalled();
  });
  it('isolates a different principal and leaves its unmatched reference to chat', async () => {
    await say('Aの報告書を作って');
    fixtures.viewer.principalId = 'human:bob';
    fixtures.run.mockClear();
    const absent = await say('Aの件どう？');
    expect(absent.body).toMatchObject({ mode: 'orchestrator', reply: 'Chat reply' });
    expect(fixtures.run).toHaveBeenCalledOnce();
  });
  it.each(['はい', '進めて', 'ok', 'What happened in 1945?', '2'])(
    'passes a conversational reply through to the runtime with a recorded request: %s',
    async (text) => {
      await say('Aの報告書を作って');
      fixtures.run.mockClear();
      const reply = await say(text);
      expect(reply.body).toMatchObject({ mode: 'orchestrator', reply: 'Chat reply' });
      expect(fixtures.run).toHaveBeenCalledOnce();
    }
  );
});
