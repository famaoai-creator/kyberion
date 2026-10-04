import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  SurfaceConversationAdmissionError,
  SurfaceConversationCapabilityError,
} from '@agent/core/surface/surface-conversation-runtime-context';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
  viewer: {
    principalId: 'human:owner',
    role: 'localadmin' as const,
    source: 'token' as const,
    tenantSlugs: ['acme'],
    organizationIds: ['org-a'],
    projectIds: ['project-a'],
    tierAccess: ['public', 'confidential'] as Array<'public' | 'confidential'>,
  },
  guard: vi.fn(() => null),
  resolve: vi.fn(),
  read: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  uncertain: vi.fn(),
  notStarted: vi.fn(),
  context: vi.fn(),
  narrow: vi.fn(),
  runtimeScope: vi.fn(),
  run: vi.fn(),
}));
vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: mocks.guard }));
vi.mock('../../../lib/viewer-context', () => ({ resolveConciergeViewer: mocks.resolve }));
vi.mock('../../../lib/conversation-store', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/core/surface/front-desk-conversation-store')
  >('@agent/core/surface/front-desk-conversation-store');
  mocks.narrow.mockImplementation(actual.narrowFrontDeskConversationViewer);
  mocks.runtimeScope.mockImplementation(actual.frontDeskRuntimeScope);
  return {
    ...actual,
    conversationRef: () => ({ sessionId: 'server-thread', key: 'a'.repeat(64) }),
    readConversationHistory: mocks.read,
    reserveConversationTurn: mocks.begin,
    markConversationTurnUncertain: mocks.uncertain,
    markConversationTurnNotStarted: mocks.notStarted,
    completeConversationTurn: mocks.complete,
    completedConversationContext: mocks.context,
    frontDeskRuntimeScope: mocks.runtimeScope,
    narrowFrontDeskConversationViewer: mocks.narrow,
  };
});
vi.mock('@agent/core/surface/channel-surface', () => ({
  runSurfaceMessageConversation: mocks.run,
}));
vi.mock('../../../lib/i18n', () => ({
  conciergeText: (key: string) => key,
  resolveConciergeLocale: () => 'en',
}));
import { GET, POST } from './route';
function request(body: unknown = {}, url = 'http://localhost/api/message') {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(null);
  mocks.resolve.mockReturnValue({ context: mocks.viewer });
  mocks.read.mockReturnValue({ sessionId: 'server-thread', messages: [], pending: 0 });
  mocks.begin.mockReturnValue({ id: REQUEST_ID, created: true });
  mocks.complete.mockImplementation(() => {});
  mocks.notStarted.mockImplementation(() => {});
  mocks.context.mockReturnValue({ messages: [], truncated: false });
  mocks.run.mockResolvedValue({ text: 'Completed.' });
});

describe('server-owned durable conversation API', () => {
  it('restores only the resolved viewer and prevents caching', async () => {
    const response = GET(request());
    expect(mocks.read).toHaveBeenCalledWith(mocks.viewer);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ sessionId: 'server-thread' });
  });
  it('honors viewer access rejection without reading history', () => {
    mocks.resolve.mockReturnValue({ response: new Response(null, { status: 403 }) });
    expect(GET(request()).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('validates GET organization/project selection before reading the matching history', () => {
    const response = GET(
      request({}, 'http://localhost/api/message?tenant=acme&organizationId=denied')
    );
    expect(response.status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('rejects forged or obsolete thread IDs before saving or execution', async () => {
    expect((await POST(request({ text: 'Do work', sessionId: 'other-owner' }))).status).toBe(409);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('saves before execution, ignores client speaker, and passes full authenticated scope', async () => {
    const response = await POST(
      request({ text: 'Do work', sessionId: 'server-thread', speaker: 'human:other' })
    );
    expect(response.status).toBe(200);
    expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0]
    );
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'human:owner',
        threadTs: 'server-thread',
        conversationKey: 'a'.repeat(64),
        correlationId: REQUEST_ID,
        messageId: REQUEST_ID,
        scope: {
          scope_kind: 'project',
          tier: 'confidential',
          tenant_slug: 'acme',
          organization_id: 'org-a',
          project_id: 'project-a',
          viewer_principal: 'human:owner',
        },
      })
    );
    expect(mocks.complete).toHaveBeenCalledWith(mocks.viewer, REQUEST_ID, 'Completed.');
  });
  it('restores completed transcript context after restart without routing/action metadata', async () => {
    const history = [
      { role: 'user', text: 'The deadline is Friday.' },
      { role: 'assistant', text: 'Friday is the deadline.' },
    ];
    mocks.context.mockReturnValue({ messages: history, truncated: true });
    const diagnostic = {
      runtimeLifetime: 'turn',
      retainedHistoryMessages: 2,
      historyTruncated: true,
      backgroundReview: 'unsupported',
      unsupportedCapabilities: ['background_review'],
    };
    mocks.run.mockResolvedValue({ text: 'Friday.', conversationRuntime: diagnostic });
    const response = await POST(
      request({ text: 'What is the deadline?', sessionId: 'server-thread' })
    );
    expect(mocks.context).toHaveBeenCalledWith(mocks.viewer);
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ conversationHistory: history, conversationHistoryTruncated: true })
    );
    expect(mocks.run.mock.calls[0][0].threadContext).toBeUndefined();
    expect(await response.json()).toMatchObject({
      reply: 'Friday.',
      conversationRuntime: diagnostic,
      requestId: REQUEST_ID,
    });
  });
  it('does not execute when saving the request fails', async () => {
    mocks.begin.mockImplementationOnce(() => {
      throw new Error('disk failure');
    });
    expect((await POST(request({ text: 'Do work', sessionId: 'server-thread' }))).status).toBe(503);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('returns the actual outcome with a persistence warning if final saving fails', async () => {
    mocks.complete.mockImplementationOnce(() => {
      throw new Error('disk failure');
    });
    const response = await POST(request({ text: 'Do work', sessionId: 'server-thread' }));
    expect(await response.json()).toMatchObject({ reply: 'Completed.', historySaved: false });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});

describe('conversation scope selection', () => {
  it('rejects ambiguous restrictions before reservation with an actionable selection response', async () => {
    mocks.resolve.mockReturnValue({
      context: { ...mocks.viewer, organizationIds: ['org-a', 'org-b'], projectIds: 'all' },
    });
    const response = await POST(request({ text: 'Hello' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'conversation_scope_selection_required',
      retry_safe: true,
      next_action: { kind: 'select_scope' },
    });
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('narrows authorized tenant, organization and project selections without widening', async () => {
    mocks.resolve.mockReturnValue({
      context: {
        ...mocks.viewer,
        tenantSlugs: ['acme', 'globex'],
        organizationIds: ['org-a', 'org-b'],
        projectIds: ['project-a', 'project-b'],
      },
    });
    const response = await POST(
      request({ text: 'Hello', tenant: 'acme', organizationId: 'org-b', projectId: 'project-b' })
    );
    expect(response.status).toBe(200);
    expect(mocks.run.mock.calls[0][0].scope).toMatchObject({
      tenant_slug: 'acme',
      organization_id: 'org-b',
      project_id: 'project-b',
      viewer_principal: 'human:owner',
    });
    expect(mocks.begin.mock.calls[0][0]).toMatchObject({
      tenantSlugs: ['acme'],
      organizationIds: ['org-b'],
      projectIds: ['project-b'],
    });
  });
  it.each([{ tenant: 'denied' }, { organizationId: 'denied' }, { projectId: 'denied' }])(
    'denies unauthorized selection before reserve: %j',
    async (selection) => {
      expect((await POST(request({ text: 'Do work', ...selection }))).status).toBe(403);
      expect(mocks.begin).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );
  it('rejects non-string lineage selections', async () => {
    expect((await POST(request({ text: 'Hello', organizationId: ['org-a'] }))).status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});

describe('conversation recovery and truthful execution states', () => {
  it('does not rerun an already pending request', async () => {
    mocks.begin.mockReturnValue({ id: REQUEST_ID, created: false });
    const response = await POST(request({ text: 'Do work', sessionId: 'server-thread' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ pending: true, retry_safe: false });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('replays completed text without restoring approval actions or executing', async () => {
    mocks.begin.mockReturnValue({ id: REQUEST_ID, created: false, reply: 'Earlier reply' });
    const response = await POST(request({ text: 'Do work', sessionId: 'server-thread' }));
    expect(await response.json()).toEqual({
      reply: 'Earlier reply',
      mode: 'history',
      shape: 'reply',
      requestId: REQUEST_ID,
      replayed: true,
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('keeps execution failure uncertain instead of persisting a success reply', async () => {
    mocks.run.mockRejectedValueOnce(new Error('provider failed'));
    const response = await POST(request({ text: 'Do work', sessionId: 'server-thread' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      retry_safe: false,
      mode: 'unavailable',
      next_action: { href: '/settings' },
    });
    expect(mocks.uncertain).toHaveBeenCalledWith(mocks.viewer, REQUEST_ID);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('makes a typed admission rejection safely retryable with the same request ID', async () => {
    mocks.run.mockRejectedValueOnce(
      new SurfaceConversationAdmissionError('SURFACE_CONVERSATION_BUSY')
    );
    const body = { text: 'Hello', sessionId: 'server-thread', requestId: REQUEST_ID };
    const rejected = await POST(request(body));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: 'conversation_not_started',
      reason: 'SURFACE_CONVERSATION_BUSY',
      retry_safe: true,
      requestId: REQUEST_ID,
    });
    expect(mocks.notStarted).toHaveBeenCalledWith(mocks.viewer, REQUEST_ID);
    expect(mocks.uncertain).not.toHaveBeenCalled();
    const retried = await POST(request(body));
    expect(retried.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls.map(([input]) => input.correlationId)).toEqual([
      REQUEST_ID,
      REQUEST_ID,
    ]);
  });
  it('retains uncertainty if writing the non-started receipt fails', async () => {
    mocks.run.mockRejectedValueOnce(
      new SurfaceConversationAdmissionError('SURFACE_CONVERSATION_CAPACITY')
    );
    mocks.notStarted.mockImplementationOnce(() => {
      throw new Error('disk failure');
    });
    const response = await POST(request({ text: 'Hello', requestId: REQUEST_ID }));
    expect(await response.json()).toMatchObject({
      error: 'conversation_execution_uncertain',
      retry_safe: false,
    });
    expect(mocks.uncertain).toHaveBeenCalledWith(mocks.viewer, REQUEST_ID);
  });
  it('does not trust a lookalike admission error to make an uncertain turn retryable', async () => {
    mocks.run.mockRejectedValueOnce({ code: 'SURFACE_CONVERSATION_BUSY', executionStarted: false });
    const response = await POST(request({ text: 'Hello' }));
    expect(await response.json()).toMatchObject({ retry_safe: false });
    expect(mocks.notStarted).not.toHaveBeenCalled();
  });
  it('returns unsupported capability as non-success and keeps a non-retryable receipt without fallback', async () => {
    mocks.run.mockRejectedValueOnce(new SurfaceConversationCapabilityError('a2a_delegation'));
    const response = await POST(request({ text: 'Delegate this work', requestId: REQUEST_ID }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'conversation_capability_unsupported',
      capability: 'a2a_delegation',
      requestId: REQUEST_ID,
      retry_safe: false,
    });
    expect(mocks.uncertain).toHaveBeenCalledWith(mocks.viewer, REQUEST_ID);
    expect(mocks.notStarted).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledOnce();
  });
  it('uses the same durable path for legacy clients without a thread ID', async () => {
    expect((await POST(request({ text: 'Hello' }))).status).toBe(200);
    expect(mocks.begin).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});
