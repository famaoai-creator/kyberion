import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SurfaceConversationAdmissionError,
  SurfaceConversationCapabilityError,
} from './surface-conversation-runtime-context.js';
import { ConversationStoreError } from './front-desk-conversation-store.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  complete: vi.fn(),
  context: vi.fn(),
  uncertain: vi.fn(),
  notStarted: vi.fn(),
  run: vi.fn(),
}));
vi.mock('./front-desk-conversation-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./front-desk-conversation-store.js')>();
  return {
    ...actual,
    reserveConversationTurn: mocks.reserve,
    completeConversationTurn: mocks.complete,
    completedConversationContext: mocks.context,
    markConversationTurnUncertain: mocks.uncertain,
    markConversationTurnNotStarted: mocks.notStarted,
  };
});
vi.mock('./channel-surface.js', () => ({ runSurfaceMessageConversation: mocks.run }));
import { runFrontDeskRequest } from './front-desk-request-service.js';
import { conversationRef } from './front-desk-conversation-store.js';

const viewer: SurfaceViewerScope = {
  principalId: 'human:owner',
  role: 'localadmin',
  source: 'token',
  tenantSlugs: ['acme'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public', 'confidential'],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.reserve.mockReturnValue({ id: REQUEST_ID, created: true });
  mocks.context.mockReturnValue({ messages: [], truncated: false });
  mocks.run.mockResolvedValue({ text: 'The conversation answer.' });
});

describe('auth-neutral shared front-desk request lifecycle', () => {
  it('reserves before runtime and derives actor, session, scope and key only from trusted viewer', async () => {
    const forged = {
      text: 'Hello',
      requestId: REQUEST_ID,
      actorId: 'human:other',
      speaker: 'human:other',
      conversationKey: 'b'.repeat(64),
      scope: { tenant_slug: 'other' },
    };
    const result = await runFrontDeskRequest(viewer, forged);
    expect(result).toMatchObject({ kind: 'replied', requestId: REQUEST_ID, historySaved: true });
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0]
    );
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: viewer.principalId,
        threadTs: conversationRef(viewer).sessionId,
        conversationKey: conversationRef(viewer).key,
        correlationId: REQUEST_ID,
        messageId: REQUEST_ID,
        scope: {
          scope_kind: 'project',
          tier: 'confidential',
          tenant_slug: 'acme',
          organization_id: 'org-a',
          project_id: 'project-a',
          viewer_principal: viewer.principalId,
        },
      })
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      viewer,
      REQUEST_ID,
      'The conversation answer.',
      'answered'
    );
  });

  it('rejects an unrepresentable viewer scope before reservation', async () => {
    expect(
      await runFrontDeskRequest({ ...viewer, tenantSlugs: ['acme', 'other'] }, { text: 'Hi' })
    ).toEqual({ kind: 'rejected', stage: 'scope', reason: 'scope_selection_required' });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('pins caller-owned identity and input before asynchronous runtime loading', async () => {
    const mutableViewer = { ...viewer, tenantSlugs: ['acme'] };
    const mutableRequest = { text: 'Original request', requestId: REQUEST_ID };
    const running = runFrontDeskRequest(mutableViewer, mutableRequest);
    mutableViewer.principalId = 'human:replacement';
    mutableViewer.tenantSlugs[0] = 'other';
    mutableRequest.text = 'Changed request';
    mutableRequest.requestId = '22222222-2222-4222-8222-222222222222';
    expect(await running).toMatchObject({ kind: 'replied', requestId: REQUEST_ID });
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Original request',
        actorId: viewer.principalId,
        conversationKey: conversationRef(viewer).key,
        scope: expect.objectContaining({
          tenant_slug: 'acme',
          viewer_principal: viewer.principalId,
        }),
      })
    );
    expect(mocks.complete.mock.calls[0][0]).toEqual(viewer);
  });

  it('rejects anonymous identity and stale session binding before reservation', async () => {
    expect(await runFrontDeskRequest({ ...viewer, source: 'anonymous' }, { text: 'Hi' })).toEqual({
      kind: 'rejected',
      stage: 'scope',
      reason: 'identity_required',
    });
    expect(
      await runFrontDeskRequest(viewer, { text: 'Hi', sessionId: 'another-conversation' })
    ).toEqual({ kind: 'rejected', stage: 'session', reason: 'scope_changed' });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    'request_conflict',
    'request_expired',
    'invalid_revision',
    'revision_conflict',
  ] as const)(
    'preserves bounded reservation rejection %s without runtime execution',
    async (code) => {
      mocks.reserve.mockImplementationOnce(() => {
        throw new ConversationStoreError(code);
      });
      expect(await runFrontDeskRequest(viewer, { text: 'Hi' })).toEqual({
        kind: 'rejected',
        stage: 'reservation',
        reason: code,
      });
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );

  it('does not expose an unknown storage error or run without a reservation', async () => {
    mocks.reserve.mockImplementationOnce(() => {
      throw new Error('/private/path unavailable');
    });
    expect(await runFrontDeskRequest(viewer, { text: 'Hi' })).toEqual({
      kind: 'rejected',
      stage: 'reservation',
      reason: 'history_unavailable',
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('restores completed text context without resurrecting routing or approval', async () => {
    const messages = [
      { role: 'user', text: 'Friday deadline' },
      { role: 'assistant', text: 'Noted' },
    ];
    mocks.context.mockReturnValue({ messages, truncated: true });
    await runFrontDeskRequest(viewer, { text: 'When?' });
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationHistory: messages,
        conversationHistoryTruncated: true,
      })
    );
    expect(mocks.run.mock.calls[0][0].threadContext).toBeUndefined();
  });

  it('replays reply text only and never builds context, projects approval or runs again', async () => {
    mocks.reserve.mockReturnValue({ id: REQUEST_ID, created: false, reply: 'Please approve.' });
    expect(await runFrontDeskRequest(viewer, { text: 'Start', requestId: REQUEST_ID })).toEqual({
      kind: 'replayed',
      requestId: REQUEST_ID,
      reply: 'Please approve.',
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not run an existing incomplete turn (uncertain=%s)',
    async (uncertain) => {
      mocks.reserve.mockReturnValue({ id: REQUEST_ID, created: false, uncertain });
      expect(await runFrontDeskRequest(viewer, { text: 'Start' })).toEqual(
        uncertain
          ? { kind: 'uncertain', requestId: REQUEST_ID, existing: true }
          : { kind: 'pending', requestId: REQUEST_ID }
      );
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );

  it('returns intake status without an execution claim or a runtime', async () => {
    mocks.reserve.mockReturnValue({
      id: REQUEST_ID,
      created: true,
      routing: { kind: 'status', reply: 'The request is waiting.' },
    });
    expect(await runFrontDeskRequest(viewer, { text: 'Status?' })).toEqual({
      kind: 'replied',
      requestId: REQUEST_ID,
      historySaved: true,
      payload: { mode: 'intake', shape: 'status_summary', reply: 'The request is waiting.' },
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(
      viewer,
      REQUEST_ID,
      'The request is waiting.',
      undefined
    );
  });

  it('admits retry only after a typed no-start error and durable receipt', async () => {
    mocks.run.mockRejectedValueOnce(
      new SurfaceConversationAdmissionError('SURFACE_CONVERSATION_BUSY')
    );
    expect(await runFrontDeskRequest(viewer, { text: 'Start' })).toEqual({
      kind: 'not_started',
      requestId: REQUEST_ID,
      reason: 'SURFACE_CONVERSATION_BUSY',
    });
    expect(mocks.notStarted).toHaveBeenCalledWith(viewer, REQUEST_ID);
    expect(mocks.uncertain).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('keeps a failed no-start receipt uncertain', async () => {
    mocks.run.mockRejectedValueOnce(
      new SurfaceConversationAdmissionError('SURFACE_CONVERSATION_CAPACITY')
    );
    mocks.notStarted.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    expect(await runFrontDeskRequest(viewer, { text: 'Start' })).toEqual({
      kind: 'uncertain',
      requestId: REQUEST_ID,
      existing: false,
    });
    expect(mocks.uncertain).toHaveBeenCalledWith(viewer, REQUEST_ID);
  });

  it('does not trust a lookalike error or retry a failed uncertain receipt', async () => {
    mocks.run.mockRejectedValueOnce({ code: 'SURFACE_CONVERSATION_BUSY', executionStarted: false });
    mocks.uncertain.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    expect(await runFrontDeskRequest(viewer, { text: 'Start' })).toEqual({
      kind: 'uncertain',
      requestId: REQUEST_ID,
      existing: false,
    });
    expect(mocks.notStarted).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('returns a capability failure without unsafe fallback', async () => {
    mocks.run.mockRejectedValueOnce(new SurfaceConversationCapabilityError('a2a_delegation'));
    expect(await runFrontDeskRequest(viewer, { text: 'Delegate' })).toEqual({
      kind: 'capability_unsupported',
      requestId: REQUEST_ID,
      capability: 'a2a_delegation',
    });
    expect(mocks.uncertain).toHaveBeenCalledWith(viewer, REQUEST_ID);
    expect(mocks.notStarted).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('keeps an empty orchestrator reply uncertain', async () => {
    mocks.run.mockResolvedValueOnce({ text: '  ' });
    expect(await runFrontDeskRequest(viewer, { text: 'Start' })).toEqual({
      kind: 'uncertain',
      requestId: REQUEST_ID,
      existing: false,
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('returns the real reply when completion saving fails, without inviting a retry', async () => {
    mocks.complete.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    expect(await runFrontDeskRequest(viewer, { text: 'Hi' })).toMatchObject({
      kind: 'replied',
      historySaved: false,
      payload: { reply: 'The conversation answer.' },
    });
    expect(mocks.notStarted).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});
