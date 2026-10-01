import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  viewer: { principalId: 'human:owner' },
  guard: vi.fn(() => null),
  resolve: vi.fn(),
  read: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  run: vi.fn(),
}));
vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: mocks.guard }));
vi.mock('../../../lib/viewer-context', () => ({
  resolveConciergeViewer: mocks.resolve,
  conciergeConversationScope: () => ({ scope_kind: 'system', tier: 'public' }),
}));
vi.mock('../../../lib/conversation-store', () => ({
  conversationRef: () => ({ sessionId: 'server-thread' }),
  readConversationHistory: mocks.read,
  beginConversationTurn: mocks.begin,
  completeConversationTurn: mocks.complete,
  ConversationStoreError: class extends Error {},
}));
vi.mock('@agent/core/surface/channel-surface', () => ({
  runSurfaceMessageConversation: mocks.run,
}));
vi.mock('../../../lib/i18n', () => ({
  conciergeText: (key: string) => key,
  resolveConciergeLocale: () => 'en',
}));
import { GET, POST } from './route';
function request(body: unknown = {}) {
  return new NextRequest('http://localhost/api/message', {
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
  mocks.begin.mockReturnValue('turn-1');
  mocks.complete.mockImplementation(() => {});
  mocks.run.mockResolvedValue({ text: 'Completed.' });
});
describe('server-owned durable conversation API', () => {
  it('restores only the resolved viewer and prevents caching', async () => {
    const response = GET(request());
    expect(mocks.read).toHaveBeenCalledWith(mocks.viewer);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ sessionId: 'server-thread' });
  });
  it('honors the viewer access rejection without reading history', () => {
    mocks.resolve.mockReturnValue({ response: new Response(null, { status: 403 }) });
    expect(GET(request()).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('rejects forged or obsolete thread IDs before saving or execution', async () => {
    expect((await POST(request({ text: 'Do work', sessionId: 'other-owner' }))).status).toBe(409);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('saves before execution and ignores a client-supplied speaker', async () => {
    const response = await POST(
      request({ text: 'Do work', sessionId: 'server-thread', speaker: 'human:other' })
    );
    expect(response.status).toBe(200);
    expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0]
    );
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'human:owner', threadTs: 'server-thread' })
    );
    expect(mocks.complete).toHaveBeenCalledWith(mocks.viewer, 'turn-1', 'Completed.');
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
