import { describe, expect, it } from 'vitest';
import { parseAgentChatErrorResponse, parseAgentChatSuccessResponse } from './agent-chat-response';

describe('agent chat response boundary', () => {
  it('accepts the success fields consumed by SovereignChat', () => {
    expect(
      parseAgentChatSuccessResponse({
        status: 'ok',
        response: 'Ready.',
        a2ui: [{ type: 'display:hero', props: { title: 'Chronos' } }],
        timestamp: '2026-09-04T00:00:00.000Z',
      })
    ).toEqual({
      status: 'ok',
      response: 'Ready.',
      a2ui: [{ type: 'display:hero', props: { title: 'Chronos' } }],
      timestamp: '2026-09-04T00:00:00.000Z',
    });
  });

  it('accepts warning responses and optional trace identifiers', () => {
    expect(
      parseAgentChatSuccessResponse({
        status: 'warning',
        response: 'Completed with warnings.',
        timestamp: '2026-09-04T00:00:00.000Z',
        traceId: 'trace-1',
        correlationId: 'corr-1',
      })
    ).toMatchObject({ status: 'warning', traceId: 'trace-1', correlationId: 'corr-1' });
  });

  it('accepts the error fields returned by the agent route', () => {
    expect(
      parseAgentChatErrorResponse({
        error: 'Request failed',
        errorCode: 'INTERNAL_ERROR',
        correlationId: 'corr-1',
        title: 'Something went wrong',
        body: 'The request could not be completed.',
        nextAction: 'Try again.',
      })
    ).toMatchObject({ error: 'Request failed', correlationId: 'corr-1' });
  });

  it('rejects malformed payloads and unsafe nested keys', () => {
    expect(
      parseAgentChatSuccessResponse({
        status: 'ok',
        response: 'Ready.',
        timestamp: '2026-09-04T00:00:00.000Z',
        a2ui: ['not-an-object'],
      })
    ).toBeUndefined();
    expect(
      parseAgentChatErrorResponse({ error: 'Request failed', correlationId: 42 })
    ).toBeUndefined();
    const unsafe = JSON.parse(
      '{"status":"ok","response":"Ready.","timestamp":"2026-09-04T00:00:00.000Z","a2ui":[{"__proto__":"bad"}]}'
    );
    expect(parseAgentChatSuccessResponse(unsafe)).toBeUndefined();
    expect(
      parseAgentChatSuccessResponse({
        status: 'ok',
        response: 'Ready.',
        timestamp: '2026-09-04T00:00:00.000Z',
        a2ui: [{ type: 'display:not-registered', props: {} }],
      })
    ).toBeUndefined();
    expect(
      parseAgentChatSuccessResponse({
        status: 'ok',
        response: 'Ready.',
        timestamp: '2026-09-04T00:00:00.000Z',
        a2ui: [
          {
            type: 'display:hero',
            props: { nested: JSON.parse('{"__proto__":{"polluted":true}}') },
          },
        ],
      })
    ).toBeUndefined();
  });
});
