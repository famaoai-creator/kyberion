import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARING_TENANT,
  OTHER_TENANT,
  call,
  hr,
  setUpHearing,
  tearDownHearing,
} from '../../../../test/hearing-route-harness';

// /api/conversation and /api/ask-vocabulary on a real installation under
// SYSTEM_ROLE=concierge (test/hearing-route-harness.ts). The conversation
// store is the real one in the temporary root; only the orchestrator turn
// (an agent runtime) is replaced, as in presence-studio conversation-routes.test.ts.
const run = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/surface/channel-surface', async (original) => ({
  ...(await original<typeof import('@agent/core/surface/channel-surface')>()),
  runSurfaceMessageConversation: run,
}));

beforeAll(() => setUpHearing(), 120_000);
afterAll(() => tearDownHearing());
beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ text: 'A real reply', delegationResults: [], approvalRequests: [] });
});

const requestId = () => crypto.randomUUID();

describe('concierge /api/ask-vocabulary', { timeout: 120_000 }, () => {
  it('serves exactly the ask keys in the requested locale to a resolved viewer', async () => {
    const { ASK_VOCABULARY_KEYS } = await import('@agent/core/surface/ask-view');
    const res = await call(
      'vocabulary',
      'GET',
      '/api/ask-vocabulary?locale=ja',
      {},
      {
        token: hr.memberToken,
      }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.locale).toBe('ja');
    expect(Object.keys(res.body.texts as object).sort()).toEqual([...ASK_VOCABULARY_KEYS].sort());
  });

  it('refuses an anonymous remote request with 401', async () => {
    const res = await call(
      'vocabulary',
      'GET',
      '/api/ask-vocabulary',
      {},
      {
        peer: false,
        token: null,
      }
    );
    expect(res.status).toBe(401);
  });
});

describe('concierge /api/conversation (頼む)', { timeout: 120_000 }, () => {
  it('restores the owner history and executes one scoped request once, then replays it', async () => {
    const history = await call('conversation', 'GET', `/api/conversation?tenant=${HEARING_TENANT}`);
    expect(history.status).toBe(200);
    expect(history.body.ok).toBe(true);
    expect(history.body.sessionId).toMatch(/^concierge-/);
    // The dock (/api/message) reads the same transcript: one conversation viewer.
    const dock = await call('message', 'GET', `/api/message?tenant=${HEARING_TENANT}`);
    expect(dock.status).toBe(200);
    expect(dock.body.sessionId).toBe(history.body.sessionId);
    const input = {
      text: 'Do this',
      conversation_id: history.body.sessionId,
      request_id: requestId(),
      tenant: HEARING_TENANT,
    };
    const reply = await call('conversation', 'POST', '/api/conversation', {}, { body: input });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      ok: true,
      reply: 'A real reply',
      mode: 'orchestrator',
      request_id: input.request_id,
      session_id: history.body.sessionId,
      historySaved: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'presence',
        text: 'Do this',
        threadTs: history.body.sessionId,
        correlationId: input.request_id,
      })
    );
    const replay = await call('conversation', 'POST', '/api/conversation', {}, { body: input });
    expect(replay.body).toMatchObject({ ok: true, mode: 'history', replayed: true });
    // The turn is in the dock's history too.
    const after = await call('message', 'GET', `/api/message?tenant=${HEARING_TENANT}`);
    expect(JSON.stringify(after.body)).toContain('A real reply');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid body (400), a changed conversation (409) and a tenant outside the viewer (403)', async () => {
    const invalid = await call(
      'conversation',
      'POST',
      '/api/conversation',
      {},
      {
        body: { text: '', extra: true },
      }
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ ok: false, error: 'invalid_conversation_request' });
    const changed = await call(
      'conversation',
      'POST',
      '/api/conversation',
      {},
      {
        body: {
          text: 'Do this',
          tenant: HEARING_TENANT,
          conversation_id: 'concierge-' + '0'.repeat(64),
          request_id: requestId(),
        },
      }
    );
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe('conversation_scope_changed');
    const foreign = await call(
      'conversation',
      'POST',
      '/api/conversation',
      {},
      {
        body: { text: 'Do this', tenant: OTHER_TENANT, request_id: requestId() },
      }
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe('conversation_access_denied');
    const foreignRead = await call(
      'conversation',
      'GET',
      `/api/conversation?tenant=${OTHER_TENANT}`
    );
    expect(foreignRead.status).toBe(403);
    expect(foreignRead.body.error).toBe('conversation_history_unavailable');
    expect(run).not.toHaveBeenCalled();
  });

  it('serves the conversation to the installation owner only, and writes only same-origin', async () => {
    const memberRead = await call(
      'conversation',
      'GET',
      '/api/conversation',
      {},
      {
        token: hr.memberToken,
      }
    );
    expect(memberRead.status).toBe(403);
    expect(memberRead.body).toMatchObject({
      ok: false,
      error: 'conversation_history_unavailable',
      error_code: 'installation_owner_required',
    });
    const memberWrite = await call(
      'conversation',
      'POST',
      '/api/conversation',
      {},
      {
        token: hr.memberToken,
        body: { text: 'Do this', tenant: HEARING_TENANT, request_id: requestId() },
      }
    );
    expect(memberWrite.status).toBe(403);
    expect(memberWrite.body.error).toBe('conversation_access_denied');
    const anonymous = await call(
      'conversation',
      'GET',
      '/api/conversation',
      {},
      {
        peer: false,
        token: null,
      }
    );
    expect(anonymous.status).toBe(401);
    for (const origin of ['https://evil.example', null]) {
      const forged = await call(
        'conversation',
        'POST',
        '/api/conversation',
        {},
        {
          origin,
          body: { text: 'Do this', tenant: HEARING_TENANT, request_id: requestId() },
        }
      );
      expect(forged.status).toBe(403);
      expect(forged.body.error).toBe('conversation_access_denied');
    }
    expect(run).not.toHaveBeenCalled();
  });
});
